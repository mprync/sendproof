<?php

declare(strict_types=1);

namespace TestBench\Symfony\Doctrine;

use Doctrine\DBAL\Connection;
use Doctrine\Persistence\ManagerRegistry;
use TestBench\Core\Contracts\PreviewObservation;
use TestBench\Core\Contracts\PreviewProvider;
use TestBench\Core\Contracts\PreviewSession;

/**
 * Preview provider for Doctrine DBAL and ORM.
 *
 * A preview opens a transaction on every configured connection before the request is dispatched,
 * so security, listeners, the controller and Doctrine lifecycle callbacks all run inside it. The
 * ORM event listener supplies row changes; see {@see OrmChangeCollector} for what is captured.
 */
class DoctrinePreviewProvider implements PreviewProvider
{
    /** @param list<string> $connections Doctrine connection names */
    public function __construct(
        protected ManagerRegistry $registry,
        protected OrmChangeCollector $collector,
        protected array $connections = ['default'],
        protected ?string $label = null,
    ) {
    }

    public function isAvailable(): bool
    {
        try {
            foreach ($this->connections as $name) {
                $this->connection($name);
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
        $params = $this->connection($this->connections[0])->getParams();
        $name = (string) ($params['path'] ?? $params['dbname'] ?? '');

        return $name === ':memory:' || $name === '' ? ($name === '' ? null : $name) : basename(str_replace('\\', '/', $name));
    }

    public function begin(mixed $context): PreviewSession
    {
        $enrolled = [];
        try {
            foreach ($this->connections as $name) {
                $connection = $this->connection($name);
                $before = $connection->getTransactionNestingLevel();
                $connection->beginTransaction();
                $enrolled[] = [$connection, $before];
            }
        } catch (\Throwable $error) {
            foreach ($enrolled as [$connection, $before]) {
                try {
                    while ($connection->getTransactionNestingLevel() > $before) {
                        $connection->rollBack();
                    }
                } catch (\Throwable) {
                    // Nothing more can be done; the original failure is reported.
                }
            }
            throw $error;
        }

        $this->collector->start();

        return new DoctrineSession($enrolled, $this->collector);
    }

    public function beginObservation(mixed $context): ?PreviewObservation
    {
        $this->collector->start();

        return new DoctrineObservation($this->collector);
    }

    private function connection(string $name): Connection
    {
        $connection = $this->registry->getConnection($name);
        if (!$connection instanceof Connection) {
            throw new \LogicException("Doctrine connection \"{$name}\" is not a DBAL connection.");
        }

        return $connection;
    }
}
