<?php

declare(strict_types=1);

namespace Sendproof\Symfony\Doctrine;

use Doctrine\DBAL\Connection;
use Sendproof\Core\Contracts\PreviewSession;

/**
 * A rollback-only transaction on one or more DBAL connections.
 *
 * Each connection remembers the nesting level it had before the preview. Rollback unwinds to
 * exactly that level and verifies it, so code that commits the outer transaction, or leaves
 * nested ones open, cannot make a preview report success without undoing its writes.
 */
final class DoctrineSession implements PreviewSession
{
    private bool $disposed = false;

    /**
     * @param list<array{0:Connection,1:int,2?:bool}> $enrolled Connection, its nesting level before the preview,
     *        and whether the Preview transaction opened with {@see DoctrinePreviewProvider::SAVEPOINT}
     * @param list<\Sendproof\Core\Preview\PreviewTurn> $turns The MySQL turns this Preview holds, handed back once its transactions have ended
     */
    public function __construct(private readonly array $enrolled, private readonly OrmChangeCollector $collector, private readonly array $turns = [])
    {
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
                if ($connection->getTransactionNestingLevel() <= $before) {
                    throw new \RuntimeException('The previewed operation committed or closed the preview transaction, so rollback cannot be confirmed.');
                }
                $this->unwind($connection, $before);
                if ($connection->getTransactionNestingLevel() !== $before || ($before === 0 && $this->nativeTransactionOpen($connection))) {
                    throw new \RuntimeException('The preview transaction is still open after rollback.');
                }
            } catch (\Throwable $error) {
                $failure ??= $error;
            }
        }

        // The transactions have ended, so the next Preview may start.
        $this->releaseTurns();
        if ($failure !== null) {
            throw $failure;
        }
    }

    private function releaseTurns(): void
    {
        foreach ($this->turns as $turn) {
            $turn->release();
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
                $this->unwind($connection, $before);
                // A refused or failed commit can leave DBAL at the starting level with the driver still inside the transaction.
                if ($before === 0 && $this->nativeTransactionOpen($connection)) {
                    $connection->getNativeConnection()->rollBack();
                }
            } catch (\Throwable) {
                // Best effort. The preview was already withheld when rollback failed earlier.
            }
        }
        $this->releaseTurns();
    }

    private function unwind(Connection $connection, int $level): void
    {
        while ($connection->getTransactionNestingLevel() > $level) {
            $connection->rollBack();
        }
    }

    /**
     * The backstop on MySQL and MariaDB: the savepoint the Preview transaction opened with must still
     * exist. Any commit, explicit or implicit, erases every savepoint, and with autocommit off MySQL then
     * opens a new transaction by itself (which `PDO::inTransaction()` reports as open), so a savepoint
     * made now would prove nothing. Error 1305 (SAVEPOINT does not exist), or a lost connection, means
     * the rollback can't be confirmed.
     */
    private function checkStillOpen(Connection $connection): void
    {
        try {
            DoctrinePreviewProvider::native($connection, 'ROLLBACK TO SAVEPOINT ' . DoctrinePreviewProvider::SAVEPOINT);
        } catch (\Throwable $error) {
            throw new \RuntimeException("The Preview transaction was committed before its rollback (its savepoint is gone), so the Preview can't be confirmed.", 0, $error);
        }
    }

    private function nativeTransactionOpen(Connection $connection): bool
    {
        $native = $connection->getNativeConnection();

        return $native instanceof \PDO && $native->inTransaction();
    }
}
