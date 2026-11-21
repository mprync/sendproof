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

    /** @param list<array{0:Connection,1:int}> $enrolled Connection and its nesting level before the preview */
    public function __construct(private readonly array $enrolled, private readonly OrmChangeCollector $collector)
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
                $this->unwind($connection, $before);
            } catch (\Throwable) {
                // Best effort. The preview was already withheld when rollback failed earlier.
            }
        }
    }

    private function unwind(Connection $connection, int $level): void
    {
        while ($connection->getTransactionNestingLevel() > $level) {
            $connection->rollBack();
        }
    }

    private function nativeTransactionOpen(Connection $connection): bool
    {
        $native = $connection->getNativeConnection();

        return $native instanceof \PDO && $native->inTransaction();
    }
}
