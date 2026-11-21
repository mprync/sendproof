<?php

declare(strict_types=1);

namespace Fixture\Support;

use Sendproof\Core\Contracts\PreviewSession;
use Sendproof\Laravel\Eloquent\EloquentPreviewProvider;

/** Rolls back for real, then reports a failure, so the transport must withhold confirmation. */
final class FailingRollbackProvider extends EloquentPreviewProvider
{
    public function begin(mixed $context): PreviewSession
    {
        $inner = parent::begin($context);

        return new class($inner) implements PreviewSession {
            public function __construct(private readonly PreviewSession $inner)
            {
            }

            public function changes(): array
            {
                return $this->inner->changes();
            }

            public function changesTruncated(): bool
            {
                return $this->inner->changesTruncated();
            }

            public function rollback(): void
            {
                $this->inner->rollback();
                throw new \RuntimeException('Injected rollback failure.');
            }

            public function dispose(): void
            {
                $this->inner->dispose();
            }
        };
    }
}
