<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Stores;

use Aws\DynamoDb\DynamoDbClient;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Redis\RedisManager;
use MongoDB\Laravel\Connection as MongoConnection;
use Sendproof\Core\Stores\DataStore;
use Sendproof\Core\Stores\DynamoDb\DynamoGuard;
use Sendproof\Core\Stores\Guard;
use Sendproof\Core\Stores\GuardOnlyStore;
use Sendproof\Core\Stores\MongoDb\GuardedClient;
use Sendproof\Core\Stores\MongoDb\MongoEngine;
use Sendproof\Core\Stores\MongoDb\MongoHook;
use Sendproof\Core\Stores\MongoDb\MongoStore;
use Sendproof\Laravel\Redis\GuardedPhpRedisConnector;
use Sendproof\Laravel\Redis\GuardedPredisConnector;

/**
 * Hooks the data stores named in `sendproof.data_stores` and returns them for the Preview runner
 * and discovery. Each hook covers only the client it is installed on (see spec/data-stores.md):
 *
 * - `mongodb`: the named `mongodb/laravel-mongodb` connection. Its client and database are replaced
 *   in place by guarded ones, so Eloquent models, the query builder and `DB::connection()` use them.
 * - `redis`: Laravel's Redis manager. Every connection it creates afterwards is guarded.
 * - `dynamodb`: the listed `Aws\DynamoDb\DynamoDbClient` services, hooked in place.
 */
final class DataStores
{
    /**
     * @param array<string,array<string,mixed>> $config The `data_stores` configuration
     * @return list<DataStore>
     */
    public static function hook(Application $app, array $config, Guard $guard): array
    {
        $stores = [];
        if (isset($config['mongodb'])) {
            $stores[] = self::mongodb($app, $config['mongodb'], $guard);
        }
        if (isset($config['redis'])) {
            $stores[] = self::redis($app, $config['redis'], $guard);
        }
        if (isset($config['dynamodb'])) {
            $stores[] = self::dynamodb($app, $config['dynamodb'], $guard);
        }

        return $stores;
    }

    /** @param array<string,mixed> $config */
    private static function mongodb(Application $app, array $config, Guard $guard): MongoStore
    {
        $connection = $app->make('db')->connection($config['connection'] ?? 'mongodb');
        if (!$connection instanceof MongoConnection) {
            throw new \InvalidArgumentException('sendproof.data_stores.mongodb.connection must name a mongodb/laravel-mongodb connection.');
        }
        $client = $connection->getClient();
        $engine = new MongoEngine(
            $client->getManager(),
            $guard,
            Guard::readSet($config['treat_as_read'] ?? null, strtolower(...)),
            (int) ($config['preview_timeout_ms'] ?? MongoEngine::DEFAULT_TIMEOUT_MS),
        );
        $guarded = new GuardedClient($client, new MongoHook($engine));
        // The connection has no setter for its client, so replace it from inside. Its `getClient()`,
        // `getDatabase()` and `getCollection()` then hand out guarded handles, and the transaction
        // helpers (`DB::transaction()`) start their session on the guarded client.
        \Closure::bind(function (GuardedClient $guarded): void {
            $this->connection = $guarded;
            $this->db = $guarded->getDatabase($this->database);
        }, $connection, MongoConnection::class)($guarded);

        return new MongoStore($engine, Guard::storeLabel($config['name'] ?? null));
    }

    /** @param array<string,mixed> $config */
    private static function redis(Application $app, array $config, Guard $guard): GuardOnlyStore
    {
        $reads = Guard::readSet($config['treat_as_read'] ?? null, strtoupper(...));
        /** @var RedisManager $manager */
        $manager = $app->make('redis');
        $driver = (string) $app['config']->get('database.redis.client', 'phpredis');
        $manager->extend($driver, fn () => $driver === 'predis' ? new GuardedPredisConnector($guard, $reads) : new GuardedPhpRedisConnector($guard, $reads));
        // Connections made before the hook was installed are dropped, so the next use builds a guarded one.
        $manager->purge();

        return new GuardOnlyStore('redis', Guard::storeLabel($config['name'] ?? null));
    }

    /** @param array<string,mixed> $config */
    private static function dynamodb(Application $app, array $config, Guard $guard): GuardOnlyStore
    {
        $reads = Guard::readSet($config['treat_as_read'] ?? null);
        foreach ((array) ($config['clients'] ?? []) as $id) {
            $client = is_object($id) ? $id : $app->make($id);
            if (!$client instanceof DynamoDbClient) {
                throw new \InvalidArgumentException('sendproof.data_stores.dynamodb.clients must name Aws\DynamoDb\DynamoDbClient services.');
            }
            DynamoGuard::install($client, $guard, $reads);
        }

        return new GuardOnlyStore('dynamodb', Guard::storeLabel($config['name'] ?? null));
    }
}
