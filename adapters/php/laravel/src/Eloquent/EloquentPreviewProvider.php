<?php

declare(strict_types=1);

namespace TestBench\Laravel\Eloquent;

use Illuminate\Database\ConnectionInterface;
use Illuminate\Database\DatabaseManager;
use TestBench\Core\Contracts\PreviewObservation;
use TestBench\Core\Contracts\PreviewProvider;
use TestBench\Core\Contracts\PreviewSession;

/**
 * Preview provider for Laravel's database layer.
 *
 * A preview opens a transaction on every configured connection before the request is dispatched,
 * so route middleware, the handler and queued after-commit work all run inside it. Eloquent
 * events supply the row changes. See {@see ChangeCollector} for what is and is not captured.
 */
class EloquentPreviewProvider implements PreviewProvider
{
    /** @param list<string|null> $connections */
    public function __construct(
        protected DatabaseManager $database,
        protected ChangeCollector $collector,
        protected array $connections = [null],
        protected ?string $label = null,
    ) {
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
        try {
            foreach ($this->connections as $name) {
                $connection = $this->database->connection($name);
                $before = $connection->transactionLevel();
                $connection->beginTransaction();
                $enrolled[] = [$connection, $before];
            }
        } catch (\Throwable $error) {
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

        return new EloquentSession($enrolled, $this->collector);
    }

    public function beginObservation(mixed $context): ?PreviewObservation
    {
        $this->collector->start();

        return new ChangeObservation($this->collector);
    }
}
