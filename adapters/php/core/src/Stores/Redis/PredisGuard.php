<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\Redis;

use Predis\Client;
use Predis\Connection\NodeConnectionInterface;
use Predis\Connection\ConnectionInterface;

/**
 * Hooks a Predis client in place (spec/data-stores.md, `guard` mode).
 *
 * Two layers, both run before a byte is written:
 *
 * - a command processor on the client's command factory, which sees every command a pipeline or
 *   transaction callback queues, so a refused write stops the whole batch before `EXEC`;
 * - a connection decorator, which sees `executeRaw()`, hand-built commands and pub/sub.
 *
 * Cluster, replication and Relay clients get the processor only: their connections are not plain
 * node (single-server) connections, which the decorator doesn't wrap. `executeRaw()` on such a client is not covered.
 */
final class PredisGuard
{
    /** @var \WeakMap<Client,true>|null */
    private static ?\WeakMap $hooked = null;

    /** Hooks `$client`. Hooking the same client twice is a no-op, so its commands are never logged twice. */
    public static function install(Client $client, RedisHook $hook): void
    {
        self::$hooked ??= new \WeakMap();
        if (isset(self::$hooked[$client])) {
            return;
        }
        self::$hooked[$client] = true;

        $factory = $client->getCommandFactory();
        $factory->setProcessor(new PredisGuardProcessor($hook, $factory->getProcessor()));

        $connection = $client->getConnection();
        if (!$connection instanceof NodeConnectionInterface) {
            return;
        }
        // Client::$connection is protected and the client has no setter, so rebind it from inside.
        \Closure::bind(function (ConnectionInterface $guarded): void {
            $this->connection = $guarded;
        }, $client, Client::class)(new GuardedPredisConnection($connection, $hook));
    }
}
