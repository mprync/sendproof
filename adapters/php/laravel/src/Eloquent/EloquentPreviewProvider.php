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
    /** @var \WeakMap<Connection,true>|null Connections that already refuse transaction control during a Preview */
    private static ?\WeakMap $guarded = null;

    /**
     * @param list<string|null> $connections
     * @param Closure(): Recorder|null $recorder Resolves the request's recorder; without it a Preview
     *                                           does not refuse a handler's `COMMIT`
     */
    public function __construct(
        protected DatabaseManager $database,
        protected ChangeCollector $collector,
        protected array $connections = [null],
        protected ?string $label = null,
        protected ?Closure $recorder = null,
    ) {
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
     * transaction (`COMMIT`, `ROLLBACK`, `BEGIN`, `SET autocommit`, and on MySQL the statements it
     * commits implicitly). The refusal also fails the Preview with 500, even if the handler
     * catches it. Savepoints stay allowed.
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
        $connection->beforeExecuting(static function (string $query) use ($mysql, $recorder): void {
            $current = $recorder();
            if ($current->isPreview() && Statements::endsTransaction($query, $mysql)) {
                $error = new PreviewTransactionControlException('A statement that would end the Preview transaction was refused during Preview.');
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
                $enrolled[] = [$connection, $before];
            }
        } catch (\Throwable $error) {
            foreach ($turns as $turn) {
                $turn->release();
            }
            foreach ($enrolled as [$connection, $before]) {
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
