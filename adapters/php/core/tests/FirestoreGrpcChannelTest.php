<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use Google\Cloud\Firestore\FirestoreClient;
use PHPUnit\Framework\TestCase;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Stores\Firestore\FirestoreGuard;
use Sendproof\Core\Stores\Guard;
use Sendproof\Core\Stores\GuardOnlyStore;
use Sendproof\Core\Stores\PreviewWriteBlockedException;
use Sendproof\Core\Tests\Support\RunsPreviews;

/**
 * The Firestore guard over a real gRPC channel (ext-grpc, gax's GrpcTransport) to a local stand-in
 * server (Support/fake-firestore-grpc.mjs), which logs each call as it opens. Reads, unary and
 * server-streaming, reach it; Commit, BatchWrite and the bidirectional Write stream never open.
 * Skipped without ext-grpc, Node, or the Node binding's @grpc/grpc-js install.
 */
final class FirestoreGrpcChannelTest extends TestCase
{
    use RunsPreviews;

    /** @var resource|null */
    private $server = null;
    private string $log = '';
    private int $port = 0;

    protected function setUp(): void
    {
        if (!extension_loaded('grpc')) {
            $this->markTestSkipped('ext-grpc is not loaded.');
        }
        $grpc = dirname(__DIR__, 3) . '/node/node_modules/@grpc/grpc-js';
        if (!is_dir($grpc) || trim((string) shell_exec('command -v node')) === '') {
            $this->markTestSkipped('Node or adapters/node/node_modules/@grpc/grpc-js is missing (run the Node binding install).');
        }
        $this->log = (string) tempnam(sys_get_temp_dir(), 'sp-firestore-grpc');
        $this->server = proc_open(['node', __DIR__ . '/Support/fake-firestore-grpc.mjs', $grpc, $this->log], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $this->assertIsResource($this->server);
        $read = [$pipes[1]];
        $none = null;
        $ready = stream_select($read, $none, $none, 10);
        $port = $ready ? trim((string) fgets($pipes[1])) : '';
        if ($port === '') {
            stream_set_blocking($pipes[2], false);
            $this->fail('The stand-in server did not start: ' . stream_get_contents($pipes[2]));
        }
        $this->assertMatchesRegularExpression('/^\d+$/', $port);
        $this->port = (int) $port;
    }

    protected function tearDown(): void
    {
        if (is_resource($this->server)) {
            proc_terminate($this->server);
            proc_close($this->server);
        }
        if ($this->log !== '' && is_file($this->log)) {
            unlink($this->log);
        }
    }

    /** @return list<string> the calls the server saw open, in order */
    private function received(): array
    {
        clearstatcache();

        return array_values(array_filter(explode("\n", (string) file_get_contents($this->log))));
    }

    private function client(Recorder $recorder): FirestoreClient
    {
        // The emulator setting gives an insecure channel to the stand-in, through gax's GrpcTransport.
        putenv('FIRESTORE_EMULATOR_HOST=127.0.0.1:' . $this->port);
        try {
            $client = new FirestoreClient(['projectId' => 'bench']);
        } finally {
            putenv('FIRESTORE_EMULATOR_HOST');
        }
        $gapic = \Closure::bind(fn () => $this->gapicClient, $client, FirestoreClient::class)();
        $this->assertInstanceOf(\Google\ApiCore\Transport\GrpcTransport::class, \Closure::bind(fn () => $this->transport, $gapic, $gapic::class)(), 'The client must send over ext-grpc');
        FirestoreGuard::install($client, new Guard(static fn () => $recorder));

        return $client;
    }

    public function testOverARealGrpcChannelReadsArriveAndNoWriteCallOpens(): void
    {
        $recorder = new Recorder();
        $client = $this->client($recorder);
        $store = new GuardOnlyStore('firestore');
        $read = $this->preview($recorder, [$store], function () use ($client): void {
            iterator_to_array($client->collection('orders')->where('status', '=', 'open')->documents());
            iterator_to_array($client->collections());
        });
        $this->assertTrue($read->isConfirmed(), json_encode($read->problem()) ?: '');
        $this->assertSame(['google.firestore.v1.Firestore/RunQuery', 'google.firestore.v1.Firestore/ListCollectionIds'], $this->received());

        $gapic = \Closure::bind(fn () => $this->gapicClient, $client, FirestoreClient::class)();
        $writes = [
            'Commit' => fn () => $client->collection('orders')->document('o-1')->set(['status' => 'new']),
            'BatchWrite' => function () use ($client): void {
                $writer = $client->bulkWriter();
                $writer->set($client->collection('orders')->document('o-2'), ['status' => 'new']);
                $writer->flush();
            },
            'Write' => function () use ($gapic): void {
                $stream = $gapic->write();
                $stream->write(new \Google\Cloud\Firestore\V1\WriteRequest(['database' => 'projects/bench/databases/(default)']));
            },
        ];
        foreach ($writes as $operation => $write) {
            $result = $this->preview($recorder, [$store], function () use ($write): void {
                try {
                    $write();
                } catch (PreviewWriteBlockedException) {
                }
            });
            $this->assertSame(409, $result->status, $operation);
            $this->assertSame($operation, $result->problem()['operation']);
        }
        $this->assertSame(['google.firestore.v1.Firestore/RunQuery', 'google.firestore.v1.Firestore/ListCollectionIds'], $this->received(), 'No write call may open during a Preview.');

        // The channel carries writes when no Preview is open: the server sees the Commit.
        $recorder->begin(false);
        $client->collection('orders')->document('o-1')->set(['status' => 'new']);
        $recorder->finish();
        $this->assertSame('google.firestore.v1.Firestore/Commit', $this->received()[2] ?? null);
    }
}
