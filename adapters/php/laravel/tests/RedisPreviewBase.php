<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Tests;

use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Facades\Route;
use Predis\Client;
use Sendproof\Core\Stores\PreviewWriteBlockedException;

/** The Laravel Redis hook (Predis and phpredis through `Redis::`), against the compose Redis. */
abstract class RedisPreviewBase extends StoresTestCase
{
    private string $prefix;
    private Client $reader;

    abstract protected function redisClient(): string;

    protected function stores(): array
    {
        return ['redis'];
    }

    protected function configure($app): void
    {
        if ($this->redisClient() === 'phpredis' && !extension_loaded('redis')) {
            $this->markTestSkipped('ext-redis is not loaded.');
        }
        $redis = Services::redis();
        $this->prefix = 'laravel_' . $this->redisClient() . '_' . bin2hex(random_bytes(4)) . ':';
        $app['config']->set('database.redis.client', $this->redisClient());
        $app['config']->set('database.redis.options.prefix', '');
        $app['config']->set('database.redis.default', ['host' => $redis['host'], 'port' => $redis['port'], 'password' => $redis['password'], 'database' => 0]);
        $app['config']->set('sendproof.data_stores', ['redis' => ['name' => 'cache']]);
        $this->reader = new Client(['host' => $redis['host'], 'port' => $redis['port'], 'password' => $redis['password']]);
        $this->reader->set($this->prefix . 'seeded', '5');
    }

    protected function tearDown(): void
    {
        if (isset($this->reader, $this->prefix)) {
            foreach ($this->reader->keys($this->prefix . '*') as $key) {
                $this->reader->del($key);
            }
        }
        parent::tearDown();
    }

    protected function storeRoutes(): void
    {
        $key = fn (string $name): string => $this->prefix . $name;
        Route::get('/counters/{name}', fn (string $name) => response()->json(['value' => (int) Redis::get($key($name))]))->sendproofPreview();
        Route::post('/counters/{name}', fn (string $name) => response()->json(['value' => Redis::incr($key($name))]))->sendproofPreview();
        // The handler catches the refusal and claims success: the mark still decides.
        Route::post('/counters/{name}/swallow', function (string $name) use ($key) {
            try {
                Redis::getdel($key($name));
            } catch (PreviewWriteBlockedException) {
            }

            return response()->json(['ok' => true]);
        })->sendproofPreview();
        Route::post('/batch/pipeline', function () use ($key) {
            Redis::pipeline(function ($pipe) use ($key): void {
                $pipe->get($key('seeded'));
                $pipe->set($key('piped'), '1');
            });

            return response()->json(['ok' => true]);
        })->sendproofPreview();
        Route::post('/batch/transaction', function () use ($key) {
            Redis::transaction(function ($tx) use ($key): void {
                $tx->get($key('seeded'));
                $tx->set($key('transacted'), '1');
            });

            return response()->json(['ok' => true]);
        })->sendproofPreview();
        Route::post('/batch/raw', fn () => response()->json(['ok' => Redis::executeRaw(['INCR', $key('raw')])]))->sendproofPreview();
        // MULTI opened by hand: phpredis hands back the client in MULTI mode, Predis a status reply.
        Route::post('/batch/multi', function () use ($key) {
            $transaction = Redis::multi();
            $target = $transaction instanceof \Predis\Response\Status ? Redis::connection() : $transaction;
            $target->set($key('multied'), '1');
            $target->exec();

            return response()->json(['ok' => true]);
        })->sendproofPreview();
        // A transaction opened without a callback whose refused write the handler swallows and abandons.
        Route::post('/batch/abandoned', function () use ($key) {
            $transaction = Redis::transaction();
            try {
                $transaction->set($key('abandoned'), '1');
            } catch (PreviewWriteBlockedException) {
            }

            return response()->json(['ok' => true]);
        })->sendproofPreview();
        Route::post('/batch/reads', function () use ($key) {
            $values = Redis::pipeline(function ($pipe) use ($key): void {
                $pipe->get($key('seeded'));
                $pipe->exists($key('seeded'));
            });

            return response()->json(['count' => count($values)]);
        })->sendproofPreview();
        Route::post('/unhooked/{name}', function (string $name) use ($key) {
            // A second client for the same store was never hooked: not covered, and documented as such.
            (new Client(['host' => Services::redis()['host'], 'port' => Services::redis()['port'], 'password' => Services::redis()['password']]))->incr($key($name));

            return response()->json(['ok' => true]);
        })->sendproofPreview();
        Route::delete('/counters/{name}', function (string $name) use ($key) {
            Redis::del($key($name));

            return response()->noContent();
        })->sendproofPreview(false, 'Clears the Redis session', ['redis']);
    }

    public function testDiscoveryListsTheStoreAndTheUnavailableOperation(): void
    {
        $this->signIn();
        $capabilities = $this->capabilities();
        $this->assertSame([['system' => 'redis', 'name' => 'cache', 'mode' => 'guard']], $capabilities['dataStores']);
        $this->assertSame([['method' => 'DELETE', 'path' => '/counters/{name}', 'reason' => 'Clears the Redis session', 'stores' => ['redis']]], $capabilities['previewUnavailable']);
        $this->assertNotContains(['method' => 'DELETE', 'path' => '/counters/{name}'], $capabilities['previewOperations']);
    }

    public function testAPreviewOfAnUnavailableOperationIsRefusedAndTheHandlerDoesNotRun(): void
    {
        $this->signIn();
        $this->reader->set($this->prefix . 'doomed', '1');
        $this->preview('/counters/doomed', [], 'DELETE')->assertStatus(409);
        $this->assertSame('1', $this->reader->get($this->prefix . 'doomed'));
        $this->json('DELETE', '/counters/doomed')->assertNoContent();
        $this->assertNull($this->reader->get($this->prefix . 'doomed'), 'Send still runs it.');
    }

    public function testReadsRunAndAreLoggedWithoutValuesOrThePassword(): void
    {
        $this->signIn();
        $envelope = $this->preview('/counters/seeded', method: 'GET')->assertOk()->assertJsonPath('body.value', 5)->json();
        $entry = $this->dbEntries($envelope, 'redis')[0]['db'];
        $this->assertSame(['system' => 'redis', 'operation' => 'GET', 'target' => $this->prefix . 'seeded', 'namespace' => '0', 'statement' => 'GET ' . $this->prefix . 'seeded'], $entry);
        $this->assertStringNotContainsString(Services::redis()['password'], json_encode($envelope));
    }

    public function testAWriteIsBlockedWithA409EvenWhenTheHandlerSwallowsTheRefusal(): void
    {
        $this->signIn();
        $blocked = $this->preview('/counters/n')->assertStatus(409);
        $this->assertSame('application/problem+json', $blocked->headers->get('Content-Type'));
        $this->assertNull($blocked->headers->get('Preference-Applied'));
        $blocked->assertJson(['code' => 'preview_unavailable', 'store' => 'redis', 'operation' => 'INCR', 'rolledBack' => false, 'detail' => 'Preview unavailable: this operation writes to Redis']);
        $this->assertNull($this->reader->get($this->prefix . 'n'), 'INCR must not reach Redis.');

        $this->preview('/counters/seeded/swallow')->assertStatus(409)->assertJsonPath('operation', 'GETDEL');
        $this->assertSame('5', $this->reader->get($this->prefix . 'seeded'), 'GETDEL must not reach Redis.');
    }

    public function testPipelinesTransactionsAndRawCommandsAreRefusedBeforeAnythingIsSent(): void
    {
        $this->signIn();
        foreach (['pipeline' => 'piped', 'transaction' => 'transacted', 'raw' => 'raw', 'multi' => 'multied'] as $route => $suffix) {
            $this->preview('/batch/' . $route)->assertStatus(409);
            $this->assertNull($this->reader->get($this->prefix . $suffix), "{$route} must not reach Redis.");
        }
        $this->preview('/batch/reads')->assertOk()->assertJsonPath('body.count', 2);
    }

    public function testASendAfterAPreviewInTheSameWorkerIsNeverBlocked(): void
    {
        // One application serves both requests, as Octane and other long-lived workers do.
        $this->signIn();
        $this->preview('/counters/next')->assertStatus(409);
        $this->json('POST', '/counters/next')->assertOk()->assertJsonPath('value', 1);
        $this->assertSame('1', $this->reader->get($this->prefix . 'next'));
    }

    public function testARefusedWriteInAnAbandonedTransactionDiscardsItSoTheConnectionStaysUsable(): void
    {
        // The connection outlives the request (Octane, queue workers): a MULTI left open would queue every later command.
        $this->signIn();
        $this->preview('/batch/abandoned')->assertStatus(409);
        $this->json('GET', '/counters/seeded')->assertOk()->assertJsonPath('value', 5);
        $this->json('POST', '/counters/after')->assertOk()->assertJsonPath('value', 1);
        $this->assertSame('1', $this->reader->get($this->prefix . 'after'), 'A Send after the refused Preview must reach Redis.');
        $this->assertNull($this->reader->get($this->prefix . 'abandoned'));
    }

    public function testObservedSendCommitsOnceAndTracesTheCommand(): void
    {
        $this->signIn();
        $response = $this->json('POST', '/counters/sent', [], ['Prefer' => 'trace'])->assertOk();
        $this->assertSame('1', $this->reader->get($this->prefix . 'sent'));
        $trace = $this->getJson('/sendproof/_api/traces/' . $response->headers->get('X-Sendproof-Trace'))->assertOk()->json();
        $this->assertSame(['INCR'], array_map(static fn (array $entry): string => $entry['db']['operation'], $this->dbEntries($trace, 'redis')));
    }

    public function testTheGuardChecksFailWhenTheHookIsRemoved(): void
    {
        // A write through a client the hook never saw is not guarded: the Preview is confirmed and the write lands. This is the documented coverage limit.
        $this->signIn();
        $this->preview('/unhooked/leak')->assertOk();
        $this->assertSame('1', $this->reader->get($this->prefix . 'leak'));
    }
}
