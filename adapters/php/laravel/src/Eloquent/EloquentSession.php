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
     * @param list<array{0:Connection,1:int}> $enrolled Connection and its level before the preview
     * @param list<PreviewTurn> $turns The MySQL turns this Preview holds, handed back once its transactions have ended
     */
    public function __construct(private readonly array $enrolled, private readonly ChangeCollector $collector, private readonly array $turns = [])
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
        foreach ($this->enrolled as [$connection, $before]) {
            try {
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
        $this->releaseTurns();
    }

    private function releaseTurns(): void
    {
        foreach ($this->turns as $turn) {
            $turn->release();
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
