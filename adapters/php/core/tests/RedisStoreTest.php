<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use PHPUnit\Framework\TestCase;
use Predis\Client;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Stores\Guard;
use Sendproof\Core\Stores\GuardOnlyStore;
use Sendproof\Core\Stores\PreviewWriteBlockedException;
use Sendproof\Core\Stores\Redis\PredisGuard;
use Sendproof\Core\Stores\Redis\RedisHook;
use Sendproof\Core\Tests\Support\RunsPreviews;
use Sendproof\Core\Tests\Support\Services;

/** The Redis write guard on a Predis client (spec/data-stores.md, `guard` mode), against the compose Redis. */
final class RedisStoreTest extends TestCase
{
    use RunsPreviews;

    private string $prefix;
    private Client $reader;

    protected function setUp(): void
    {
        Services::need('redis');
        $this->prefix = 'php_core_' . bin2hex(random_bytes(4)) . ':';
        $this->reader = $this->client();
        $this->reader->set($this->prefix . 'seeded', '5');
    }

    protected function tearDown(): void
    {
        if (isset($this->reader)) {
            foreach ($this->reader->keys($this->prefix . '*') as $key) {
                $this->reader->del($key);
            }
        }
    }

    private function client(): Client
    {
        $redis = Services::redis();

        return new Client(['scheme' => 'tcp', 'host' => $redis['host'], 'port' => $redis['port'], 'password' => $redis['password'], 'timeout' => 2.0, 'read_write_timeout' => 2.0]);
    }

    /** @return array{0:Recorder,1:Client,2:GuardOnlyStore} */
    private function hooked(?array $reads = null): array
    {
        $recorder = new Recorder();
        $client = $this->client();
        PredisGuard::install($client, new RedisHook(new Guard(static fn () => $recorder), $reads, '0'));

        return [$recorder, $client, new GuardOnlyStore('redis', 'cache')];
    }

    public function testReadsRunAndWritesAreRefusedBeforeAnyByteIsSent(): void
    {
        [$recorder, $client, $store] = $this->hooked();
        $this->assertSame(['system' => 'redis', 'name' => 'cache', 'mode' => 'guard'], $store->describe());

        $read = $this->preview($recorder, [$store], fn () => $client->get($this->prefix . 'seeded'));
        $this->assertTrue($read->isConfirmed());
        $entry = array_values(array_filter($read->envelope['logs'], static fn (array $log): bool => $log['level'] === 'Db'))[0];
        $this->assertSame(['system' => 'redis', 'operation' => 'GET', 'target' => $this->prefix . 'seeded', 'namespace' => '0', 'statement' => 'GET ' . $this->prefix . 'seeded'], $entry['db']);

        foreach (['INCR' => fn () => $client->incr($this->prefix . 'n'), 'GETDEL' => fn () => $client->getdel($this->prefix . 'seeded'), 'SET' => fn () => $client->set($this->prefix . 's', 'v'), 'PUBLISH' => fn () => $client->publish('ch', 'm')] as $operation => $call) {
            $result = $this->preview($recorder, [$store], function () use ($call): void {
                try {
                    $call();
                } catch (PreviewWriteBlockedException) {
                    // The handler swallows it; the mark still decides.
                }
            });
            $this->assertSame(409, $result->status, $operation);
            $this->assertSame($operation, $result->problem()['operation']);
        }
        $this->assertNull($this->reader->get($this->prefix . 'n'), 'INCR must not reach Redis');
        $this->assertSame('5', $this->reader->get($this->prefix . 'seeded'), 'GETDEL must not reach Redis');
        $this->assertNull($this->reader->get($this->prefix . 's'));
    }

    public function testPipelinesTransactionsAndRawCommandsAreRefusedBeforeTheBatchIsWritten(): void
    {
        [$recorder, $client, $store] = $this->hooked();
        foreach ([
            'pipeline' => fn () => $client->pipeline(function ($pipe): void {
                $pipe->get($this->prefix . 'seeded');
                $pipe->set($this->prefix . 'p', '1');
            }),
            'transaction' => fn () => $client->transaction(function ($tx): void {
                $tx->get($this->prefix . 'seeded');
                $tx->set($this->prefix . 't', '1');
            }),
            'hand-built command in a pipeline' => fn () => $client->pipeline(function ($pipe): void {
                $pipe->executeCommand(new \Predis\Command\RawCommand('SET', [$this->prefix . 'hbp', 'v']));
            }),
            'raw' => fn () => $client->executeRaw(['INCR', $this->prefix . 'raw']),
            'hand-built command' => fn () => $client->executeCommand(new \Predis\Command\RawCommand('SET', [$this->prefix . 'hb', 'v'])),
        ] as $label => $call) {
            $result = $this->preview($recorder, [$store], function () use ($call): void {
                try {
                    $call();
                } catch (PreviewWriteBlockedException) {
                }
            });
            $this->assertSame(409, $result->status, $label);
        }
        foreach (['p', 't', 'raw', 'hb', 'hbp'] as $suffix) {
            $this->assertNull($this->reader->get($this->prefix . $suffix), "{$suffix} must not reach Redis");
        }
        // The client is still usable after the refusals: no half-written pipeline or MULTI is left on the connection.
        $this->assertSame('5', $client->get($this->prefix . 'seeded'));
        $read = $this->preview($recorder, [$store], fn () => $client->mget([$this->prefix . 'seeded']));
        $this->assertTrue($read->isConfirmed());
    }

    public function testClusterAndReplicationClientsRefuseRawAndHandBuiltWritesToo(): void
    {
        $redis = Services::redis();
        $node = ['scheme' => 'tcp', 'host' => $redis['host'], 'port' => $redis['port'], 'password' => $redis['password'], 'timeout' => 2.0, 'read_write_timeout' => 2.0];
        foreach ([
            'predis cluster' => static fn (): Client => new Client([$node], ['cluster' => 'predis']),
            'replication' => static fn (): Client => new Client([$node + ['role' => 'master']], ['replication' => 'predis']),
        ] as $label => $make) {
            $recorder = new Recorder();
            $client = $make();
            PredisGuard::install($client, new RedisHook(new Guard(static fn () => $recorder), null, '0'));
            $store = new GuardOnlyStore('redis');
            foreach ([
                'raw' => fn () => $client->executeRaw(['SET', $this->prefix . 'aggregate-raw', '1']),
                'hand-built' => fn () => $client->executeCommand(new \Predis\Command\RawCommand('SET', [$this->prefix . 'aggregate-built', '1'])),
            ] as $path => $call) {
                $result = $this->preview($recorder, [$store], function () use ($call): void {
                    try {
                        $call();
                    } catch (PreviewWriteBlockedException) {
                    }
                });
                $this->assertSame(409, $result->status, "{$label}, {$path}");
            }
            $this->assertNull($this->reader->get($this->prefix . 'aggregate-raw'), "{$label}: executeRaw must not reach Redis");
            $this->assertNull($this->reader->get($this->prefix . 'aggregate-built'), "{$label}: a hand-built command must not reach Redis");
            $read = $this->preview($recorder, [$store], fn () => $client->executeRaw(['GET', $this->prefix . 'seeded']));
            $this->assertTrue($read->isConfirmed(), "{$label}: reads still run");
            $this->assertSame('5', $client->get($this->prefix . 'seeded'));
        }
    }

    public function testAPipelineOfReadsRunsAndIsLogged(): void
    {
        [$recorder, $client, $store] = $this->hooked();
        $result = $this->preview($recorder, [$store], fn () => $client->pipeline(function ($pipe): void {
            $pipe->get($this->prefix . 'seeded');
            $pipe->exists($this->prefix . 'seeded');
        }));
        $this->assertTrue($result->isConfirmed());
        $operations = array_map(static fn (array $log): string => $log['db']['operation'], array_filter($result->envelope['logs'], static fn (array $log): bool => $log['level'] === 'Db'));
        $this->assertSame(['GET', 'EXISTS'], array_values($operations));
    }

    public function testObservedSendCommitsOnceAndTracesTheCommandWithoutValues(): void
    {
        [$recorder, $client] = $this->hooked();
        $recorder->begin(false);
        $client->set($this->prefix . 'sent', 'secret-value');
        $capture = $recorder->finish();
        $this->assertSame('secret-value', $this->reader->get($this->prefix . 'sent'), 'Send commits normally.');
        $statements = array_values(array_map(static fn (array $log): string => $log['db']['statement'], array_filter($capture['logs'], static fn (array $log): bool => $log['level'] === 'Db')));
        $this->assertSame(['SET ' . $this->prefix . 'sent ?'], $statements);
        $this->assertStringNotContainsString('secret-value', json_encode($capture));
    }

    public function testThePasswordAndSessionCommandsNeverReachACapture(): void
    {
        $recorder = new Recorder();
        $client = $this->client();
        PredisGuard::install($client, new RedisHook(new Guard(static fn () => $recorder)));
        $recorder->begin(false);
        // The first command connects, which sends AUTH with the password.
        $client->ping();
        $client->get($this->prefix . 'seeded');
        $text = json_encode($recorder->finish());
        $this->assertStringNotContainsString(Services::redis()['password'], $text);
        $this->assertDoesNotMatchRegularExpression('/"operation":"(AUTH|HELLO|PING|SELECT)"/', $text);
    }

    public function testHostDeclaredReadsAreAllowedByExactNameOnly(): void
    {
        [$recorder, $client, $store] = $this->hooked(Guard::readSet(['DBSIZE2', 'FLUSHALL'], strtoupper(...)));
        // FLUSHALL is declared a read: the guard trusts the host, so this wipes the test database. Use a command that is harmless instead.
        $result = $this->preview($recorder, [$store], function () use ($client): void {
            try {
                $client->executeRaw(['DBSIZE2']);
            } catch (\Throwable $error) {
                $this->assertNotInstanceOf(PreviewWriteBlockedException::class, $error, 'A declared read is not refused by the guard (the server may not know it).');
            }
        });
        $this->assertTrue($result->isConfirmed());
        $this->assertSame(409, $this->preview($recorder, [$store], function () use ($client): void {
            try {
                $client->executeRaw(['DBSIZE22']);
            } catch (PreviewWriteBlockedException) {
            }
        })->status, 'Names match exactly, with no wildcards.');
    }

    public function testTheGuardChecksFailWhenTheHookIsRemoved(): void
    {
        $recorder = new Recorder();
        $unhooked = $this->client();
        $result = $this->preview($recorder, [new GuardOnlyStore('redis')], function () use ($unhooked): void {
            $unhooked->incr($this->prefix . 'unhooked');
        });
        $this->assertTrue($result->isConfirmed(), 'Without the hook nothing marks the write, so the Preview is wrongly confirmed.');
        $this->assertSame('1', $this->reader->get($this->prefix . 'unhooked'), 'The unhooked write reached Redis: exactly what the hook prevents.');
    }
}
