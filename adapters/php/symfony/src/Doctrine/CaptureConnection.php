<?php

declare(strict_types=1);

namespace Sendproof\Symfony\Doctrine;

use Doctrine\DBAL\Driver\Connection as ConnectionInterface;
use Doctrine\DBAL\Driver\Middleware\AbstractConnectionMiddleware;
use Doctrine\DBAL\Driver\Result;
use Doctrine\DBAL\Driver\Statement as StatementInterface;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Capture\SqlRedactor;
use Sendproof\Core\Capture\Statements;
use Sendproof\Core\Stores\PreviewTransactionControlException;

/**
 * Records statements that run without prepared parameters, and wraps prepared ones.
 *
 * During a Preview it also refuses, before the statement reaches the database, anything that would
 * end or escape the Preview transaction (`COMMIT`, `ROLLBACK`, `BEGIN`, `SET autocommit`, the
 * Preview's own savepoint, and on MySQL the statements it commits implicitly, `EXECUTE` and `CALL`
 * of a procedure not declared safe) and a driver-level commit. The refusal fails the Preview with
 * 500 even if the handler catches it. Savepoints stay allowed.
 */
final class CaptureConnection extends AbstractConnectionMiddleware
{
    private const CATEGORY = 'Doctrine.DBAL.Connection';

    /** @param list<string> $safeProcedures see {@see CaptureMiddleware} */
    public function __construct(ConnectionInterface $connection, private readonly Recorder $recorder, private readonly bool $showValues, private readonly bool $mysql = false, private readonly array $safeProcedures = [])
    {
        parent::__construct($connection);
    }

    public function prepare(string $sql): StatementInterface
    {
        $this->refuseTransactionControl($sql);

        return new CaptureStatement(parent::prepare($sql), $sql, $this->recorder, $this->showValues);
    }

    public function commit(): void
    {
        // DBAL reaches the driver only for the outermost transaction, which a Preview owns.
        if ($this->recorder->isPreview()) {
            $this->refuse('A commit that would end the Preview transaction was refused during Preview.');
        }
        parent::commit();
    }

    public function query(string $sql): Result
    {
        $this->refuseTransactionControl($sql);
        $started = hrtime(true);
        $result = parent::query($sql);
        $this->record($sql, $started, null);

        return $result;
    }

    public function exec(string $sql): int|string
    {
        $this->refuseTransactionControl($sql);
        $started = hrtime(true);
        $affected = parent::exec($sql);
        $this->record($sql, $started, is_int($affected) ? $affected : null);

        return $affected;
    }

    private function refuseTransactionControl(string $sql): void
    {
        if ($this->recorder->isPreview()
            && ($reason = Statements::reason($sql, $this->mysql, $this->safeProcedures, DoctrinePreviewProvider::SAVEPOINT)) !== null) {
            $this->refuse("A statement that would end the Preview transaction was refused during Preview: {$reason}.");
        }
    }

    private function refuse(string $message): never
    {
        $error = new PreviewTransactionControlException($message);
        $this->recorder->refuse($error);

        throw $error;
    }

    private function record(string $sql, int $started, ?int $rows): void
    {
        if (!$this->recorder->isCapturing() || self::isSavepoint($sql)) {
            return;
        }
        [$entry, $truncated] = SqlRedactor::entry($sql, [], $this->showValues, $rows);
        $this->recorder->recordSql((hrtime(true) - $started) / 1e6, $entry, $truncated, self::CATEGORY);
    }

    /** Whether the statement is a savepoint command Doctrine issues for nested transactions. */
    public static function isSavepoint(string $sql): bool
    {
        return (bool) preg_match('/^\s*(?:release\s+|rollback\s+to\s+)?savepoint\b/i', $sql);
    }
}
