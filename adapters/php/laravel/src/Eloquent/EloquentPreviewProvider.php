<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Eloquent;

use Closure;
use Illuminate\Database\Connection;
use Illuminate\Database\DatabaseManager;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Capture\Statements;
use Sendproof\Core\Contracts\DescribesDatabaseSystem;
use Sendproof\Core\Contracts\PreviewObservation;
use Sendproof\Core\Contracts\PreviewProvider;
use Sendproof\Core\Contracts\PreviewSession;
use Sendproof\Core\Preview\PreviewTurn;
use Sendproof\Core\Preview\PreviewTurns;
use Sendproof\Core\Stores\PreviewTransactionControlException;

/**
 * Preview provider for Laravel's database layer.
 *
 * A preview opens a transaction on every configured connection before the request is dispatched,
 * so route middleware, the handler and queued after-commit work all run inside it. Eloquent
 * events supply the row changes. See {@see ChangeCollector} for what is and is not captured.
 */
class EloquentPreviewProvider implements PreviewProvider, DescribesDatabaseSystem
{
    /**
     * The savepoint a MySQL or MariaDB Preview opens its transaction with, for the backstop in
     * {@see EloquentSession::rollback()}. Laravel names its own savepoints `trans<n>`, so it never
     * makes this one, and a handler's `RELEASE` or `ROLLBACK TO` of it is refused like a `COMMIT`.
     */
    public const SAVEPOINT = 'sendproof_preview';

    /** @var \WeakMap<Connection,true>|null Connections that already refuse transaction control during a Preview */
    private static ?\WeakMap $guarded = null;

    /** @var list<string> Procedures the host declared never commit, lower-cased */
    protected array $safeProcedures;

    /**
     * @param list<string|null> $connections
     * @param Closure(): Recorder|null $recorder Resolves the request's recorder; without it a Preview
     *                                           does not refuse a handler's `COMMIT`
     * @param iterable<string> $safeProcedures On MySQL and MariaDB a Preview refuses `CALL`, because a
     *        stored procedure can commit the Preview transaction. List the procedures that never commit,
     *        by exact name (optionally `schema.name`; case-insensitive, like MySQL), to allow calling
     *        them. The binding trusts the list: a listed procedure that does commit makes the Preview's
     *        writes durable, and the savepoint check before the rollback then answers 500.
     * @throws \InvalidArgumentException when a safe procedure is not an exact name
     */
    public function __construct(
        protected DatabaseManager $database,
        protected ChangeCollector $collector,
        protected array $connections = [null],
        protected ?string $label = null,
        protected ?Closure $recorder = null,
        iterable $safeProcedures = [],
    ) {
        $this->safeProcedures = Statements::normalizeProcedures($safeProcedures);
    }

    public function databaseSystem(): ?string
    {
        try {
            return match ($this->database->connection($this->connections[0] ?? null)->getDriverName()) {
                'sqlite' => 'sqlite',
                'mysql' => 'mysql',
                'mariadb' => 'mariadb',
                'pgsql' => 'postgresql',
                'sqlsrv' => 'sqlserver',
                default => null,
            };
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * Whether Previews on this connection take turns. MySQL and MariaDB deadlock when three or
     * more Previews insert one new key at once and the first rolls back, at any isolation level.
     */
    protected function takesTurns(Connection $connection): bool
    {
        return in_array($connection->getDriverName(), ['mysql', 'mariadb'], true);
    }

    /**
     * Refuses, before it reaches the database, any statement that would end or escape the Preview
     * transaction (`COMMIT`, `ROLLBACK`, `BEGIN`, `SET autocommit`, the {@see SAVEPOINT}, and on
     * MySQL the statements it commits implicitly, `EXECUTE` and `CALL` of an undeclared procedure).
     * The refusal also fails the Preview with 500, even if the handler catches it. Savepoints stay
     * allowed.
     */
    protected function refuseTransactionControl(Connection $connection): void
    {
        if ($this->recorder === null) {
            return;
        }
        self::$guarded ??= new \WeakMap();
        if (isset(self::$guarded[$connection])) {
            return;
        }
        self::$guarded[$connection] = true;
        $mysql = $this->takesTurns($connection);
        $recorder = $this->recorder;
        $safe = $this->safeProcedures;
        $connection->beforeExecuting(static function (string $query) use ($mysql, $recorder, $safe): void {
            $current = $recorder();
            if ($current->isPreview() && ($reason = Statements::reason($query, $mysql, $safe, self::SAVEPOINT)) !== null) {
                $error = new PreviewTransactionControlException("A statement that would end the Preview transaction was refused during Preview: {$reason}.");
                $current->refuse($error);

                throw $error;
            }
        });
    }

    public function isAvailable(): bool
    {
        try {
            foreach ($this->connections as $name) {
                $this->database->connection($name);
            }

            return $this->connections !== [];
        } catch (\Throwable) {
            return false;
        }
    }

    public function database(): ?string
    {
        if ($this->label !== null && $this->label !== '') {
            return $this->label;
        }
        $name = $this->database->connection($this->connections[0] ?? null)->getDatabaseName();

        return $name === ':memory:' || $name === '' ? $name : basename(str_replace('\\', '/', (string) $name));
    }

    public function begin(mixed $context): PreviewSession
    {
        $enrolled = [];
        $turns = [];
        try {
            foreach ($this->connections as $name) {
                $connection = $this->database->connection($name);
                $this->refuseTransactionControl($connection);
                if ($this->takesTurns($connection)) {
                    // One Preview at a time per database, taken before the connection is touched.
                    $turns[] = PreviewTurns::take($this->turnKey($connection));
                }
                $before = $connection->transactionLevel();
                $connection->beginTransaction();
                $marked = in_array($connection->getDriverName(), ['mysql', 'mariadb'], true);
                $enrolled[] = [$connection, $before, $marked];
                if ($marked) {
                    // The backstop's mark, made first thing in the Preview transaction, on the PDO itself
                    // so it neither passes the handler's guard nor shows in the SQL log.
                    $connection->getPdo()->exec('SAVEPOINT ' . self::SAVEPOINT);
                }
            }
        } catch (\Throwable $error) {
            foreach ($turns as $turn) {
                $turn->release();
            }
            foreach ($enrolled as [$connection, $before, $_]) {
                try {
                    $connection->rollBack($before);
                } catch (\Throwable) {
                    // Nothing more can be done; the original failure is reported.
                }
            }
            throw $error;
        }

        $this->collector->start();

        return new EloquentSession($enrolled, $this->collector, $turns);
    }

    /** Identifies the database a connection points at, for its turn lock. */
    private function turnKey(Connection $connection): string
    {
        return implode('|', [(string) $connection->getConfig('host'), (string) $connection->getConfig('port'), (string) $connection->getDatabaseName()]);
    }

    public function beginObservation(mixed $context): ?PreviewObservation
    {
        $this->collector->start();

        return new ChangeObservation($this->collector);
    }
}
