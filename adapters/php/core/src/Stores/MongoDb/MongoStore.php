<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\MongoDb;

use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Stores\DataStore;

/**
 * A hooked MongoDB client, ready to register with the Preview runner and discovery.
 *
 * On a replica set or sharded cluster a Preview runs every command in one transaction that is
 * aborted after the handler, and reports document changes. On a standalone server MongoDB can't
 * run transactions, so the store runs in `guard` mode like Redis: reads run and the first write
 * blocks the Preview.
 */
final class MongoStore implements DataStore
{
    public function __construct(public readonly MongoEngine $engine, private readonly ?string $name = null)
    {
    }

    public function system(): string
    {
        return 'mongodb';
    }

    public function describe(): array
    {
        return ['system' => 'mongodb'] + ($this->name === null ? [] : ['name' => $this->name]) + $this->engine->detect();
    }

    public function begin(Recorder $recorder): void
    {
        $this->engine->begin($recorder);
    }

    public function finish(Recorder $recorder): void
    {
        $this->engine->finish($recorder);
    }
}
