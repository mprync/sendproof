<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Eloquent;

use Illuminate\Database\Connection;
use Sendproof\Core\Contracts\PreviewSession;
use Sendproof\Core\Preview\PreviewTurn;

/**
 * A rollback-only transaction on one or more connections.
 *
 * Each connection records the transaction level it had before the preview. Rollback returns to
 * exactly that level and verifies it, so code that commits, or leaves transactions open, cannot
 * cause a preview to report success without actually undoing its writes.
 */
final class EloquentSession implements PreviewSession
{
    private bool $disposed = false;

    /**
     * @param list<array{0:Connection,1:int,2?:bool}> $enrolled Connection, its level before the preview,
     *        and whether the Preview transaction opened with {@see EloquentPreviewProvider::SAVEPOINT}
     * @param list<PreviewTurn> $turns The MySQL turns this Preview holds, handed back once its transactions have ended
     * @param list<\Closure(): void> $restore Put each connection's own statement class back once the Preview ends
     */
    public function __construct(private readonly array $enrolled, private readonly ChangeCollector $collector, private readonly array $turns = [], private array $restore = [])
    {
    }

    private function restoreStatements(): void
    {
        $restore = $this->restore;
        $this->restore = [];
        foreach ($restore as $undo) {
            try {
                $undo();
            } catch (\Throwable) {
                // A lost connection keeps nothing to restore.
            }
        }
    }

    public function changes(): array
    {
        return $this->collector->changes();
    }

    public function changesTruncated(): bool
    {
        return $this->collector->truncated();
    }

    public function rollback(): void
    {
        $failure = null;
        foreach ($this->enrolled as $enrollment) {
            [$connection, $before] = $enrollment;
            try {
                if ($enrollment[2] ?? false) {
                    $this->checkStillOpen($connection);
                }
                // A raw COMMIT (DB::unprepared('COMMIT') or the PDO itself) leaves Laravel's level
                // counter untouched, and Laravel then skips the rollback silently, so ask the driver.
                if ($connection->transactionLevel() <= $before || ($before === 0 && $this->transactionLost($connection))) {
                    throw new \RuntimeException('The previewed operation committed or closed the preview transaction, so rollback cannot be confirmed.');
                }
                $connection->rollBack($before);
                if ($connection->transactionLevel() !== $before || ($before === 0 && $this->inTransaction($connection))) {
                    throw new \RuntimeException('The preview transaction is still open after rollback.');
                }
            } catch (\Throwable $error) {
                $failure ??= $error;
            }
        }

        // The transaction has ended, so the next Preview may start.
        $this->restoreStatements();
        $this->releaseTurns();
        if ($failure !== null) {
            throw $failure;
        }
    }

    public function dispose(): void
    {
        if ($this->disposed) {
            return;
        }
        $this->disposed = true;
        $this->collector->stop();
        foreach ($this->enrolled as [$connection, $before]) {
            try {
                if ($connection->transactionLevel() > $before) {
                    $connection->rollBack($before);
                }
            } catch (\Throwable) {
                // Best effort. The preview was already withheld when rollback failed earlier.
            }
        }
        $this->restoreStatements();
        $this->releaseTurns();
    }

    private function releaseTurns(): void
    {
        foreach ($this->turns as $turn) {
            $turn->release();
        }
    }

    /**
     * The backstop, on every database: the savepoint the Preview transaction opened with must still
     * exist. Any commit, explicit or implicit, erases every savepoint, and the driver (or MySQL with
     * autocommit off) may then open a new transaction by itself (which `PDO::inTransaction()` reports as
     * open), so a savepoint made now would prove nothing. A missing savepoint, or a lost connection,
     * means the rollback can't be confirmed. SQL Server can't test a savepoint without rolling back to
     * it, so there the transaction must still be open (`@@TRANCOUNT` at least 1, `XACT_STATE()` not 0).
     */
    private function checkStillOpen(Connection $connection): void
    {
        try {
            $pdo = $connection->getPdo();
            if ($connection->getDriverName() === 'sqlsrv') {
                [$count, $state] = $pdo->query('SELECT @@TRANCOUNT, XACT_STATE()')->fetch(\PDO::FETCH_NUM);
                if ((int) $count < 1 || (int) $state === 0) {
                    throw new \RuntimeException('No transaction is open.');
                }

                return;
            }
            $pdo->exec('ROLLBACK TO SAVEPOINT ' . EloquentPreviewProvider::SAVEPOINT);
        } catch (\Throwable $error) {
            throw new \RuntimeException("The Preview transaction was committed before its rollback (its savepoint is gone), so the Preview can't be confirmed.", 0, $error);
        }
    }

    /** True when the driver reports that the transaction the preview opened is gone. */
    private function transactionLost(Connection $connection): bool
    {
        $pdo = $connection->getRawPdo();

        return $pdo instanceof \PDO && !$pdo->inTransaction();
    }

    private function inTransaction(Connection $connection): bool
    {
        $pdo = $connection->getRawPdo();

        return $pdo instanceof \PDO && $pdo->inTransaction();
    }
}
