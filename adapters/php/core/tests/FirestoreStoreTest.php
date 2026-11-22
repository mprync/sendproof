<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use Google\ApiCore\Call;
use Google\Cloud\Firestore\FirestoreClient;
use Google\Cloud\Firestore\V1\BatchGetDocumentsRequest;
use Google\Cloud\Firestore\V1\BatchWriteRequest;
use Google\Cloud\Firestore\V1\BeginTransactionRequest;
use Google\Cloud\Firestore\V1\CommitRequest;
use Google\Cloud\Firestore\V1\ListCollectionIdsRequest;
use Google\Cloud\Firestore\V1\ListDocumentsRequest;
use Google\Cloud\Firestore\V1\RollbackRequest;
use Google\Cloud\Firestore\V1\RunAggregationQueryRequest;
use Google\Cloud\Firestore\V1\RunQueryRequest;
use Google\Protobuf\Internal\Message;
use PHPUnit\Framework\AssertionFailedError;
use PHPUnit\Framework\TestCase;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Stores\Firestore\FirestoreGuard;
use Sendproof\Core\Stores\Firestore\GuardedFirestoreTransport;
use Sendproof\Core\Stores\Guard;
use Sendproof\Core\Stores\GuardOnlyStore;
use Sendproof\Core\Stores\PreviewWriteBlockedException;
use Sendproof\Core\Tests\Support\RecordingFirestoreTransport;
use Sendproof\Core\Tests\Support\RunsPreviews;

/**
 * The Firestore write guard (spec/data-stores.md, `guard` mode) on the real `google/cloud-firestore`
 * client, over a fake gax transport that records what reaches the network, and on the requests of
 * spec/data-stores/recordings/firestore.json replayed through the hook. The client is hooked after it
 * is built. The tests need no `ext-grpc`: the guard sits on the transport interface every call uses.
 */
final class FirestoreStoreTest extends TestCase
{
    use RunsPreviews;

    private const RECORDINGS = __DIR__ . '/../../../../spec/data-stores/recordings/firestore.json';

    /** The V1 request class and call type of each method the recordings use. */
    private const REQUESTS = [
        'BatchGetDocuments' => [BatchGetDocumentsRequest::class, Call::SERVER_STREAMING_CALL],
        'RunQuery' => [RunQueryRequest::class, Call::SERVER_STREAMING_CALL],
        'RunAggregationQuery' => [RunAggregationQueryRequest::class, Call::SERVER_STREAMING_CALL],
        'ListCollectionIds' => [ListCollectionIdsRequest::class, Call::UNARY_CALL],
        'ListDocuments' => [ListDocumentsRequest::class, Call::UNARY_CALL],
        'Commit' => [CommitRequest::class, Call::UNARY_CALL],
        'BatchWrite' => [BatchWriteRequest::class, Call::UNARY_CALL],
        'BeginTransaction' => [BeginTransactionRequest::class, Call::UNARY_CALL],
        'Rollback' => [RollbackRequest::class, Call::UNARY_CALL],
    ];

    /** @return array{0:Recorder,1:FirestoreClient,2:RecordingFirestoreTransport,3:GuardOnlyStore} */
    private function hooked(bool $hook = true, ?array $reads = null): array
    {
        $recorder = new Recorder();
        $fake = new RecordingFirestoreTransport();
        // The emulator setting makes the client skip credentials; nothing is ever sent to it.
        putenv('FIRESTORE_EMULATOR_HOST=127.0.0.1:1');
        try {
            $client = new FirestoreClient(['projectId' => 'bench', 'transport' => $fake]);
        } finally {
            putenv('FIRESTORE_EMULATOR_HOST');
        }
        if ($hook) {
            FirestoreGuard::install($client, new Guard(static fn () => $recorder), $reads);
        }

        return [$recorder, $client, $fake, new GuardOnlyStore('firestore', 'orders')];
    }

    /** @return array<string,\Closure> the writes of the SDK, by the method the 409 reports */
    private function writes(FirestoreClient $client): array
    {
        $order = $client->collection('orders')->document('o-1');

        return [
            'set' => ['Commit', fn () => $order->set(['status' => 'new'])],
            'create' => ['Commit', fn () => $client->collection('orders')->add(['status' => 'new'])],
            'update' => ['Commit', fn () => $order->update([['path' => 'status', 'value' => 'closed']])],
            'delete' => ['Commit', fn () => $order->delete()],
            'transaction' => ['Commit', fn () => $client->runTransaction(fn ($transaction) => $transaction->set($order, ['status' => 'x']))],
            'bulk writer' => ['BatchWrite', function () use ($client, $order): void {
                $writer = $client->bulkWriter();
                $writer->set($order, ['status' => 'bulk']);
                $writer->flush();
            }],
        ];
    }

    public function testReadsRunAndEveryWriteIsRefusedBeforeItIsSent(): void
    {
        [$recorder, $client, $fake, $store] = $this->hooked();
        $read = $this->preview($recorder, [$store], function () use ($client): void {
            $client->collection('orders')->document('o-1')->snapshot();
            iterator_to_array($client->collection('orders')->where('status', '=', 'open')->documents());
        });
        $this->assertTrue($read->isConfirmed(), 'Reads run');
        $this->assertSame(['BatchGetDocuments', 'RunQuery'], $fake->methods());
        $entries = array_values(array_filter($read->envelope['logs'], static fn (array $log): bool => $log['level'] === 'Db'));
        $this->assertSame(['BatchGetDocuments', 'RunQuery'], array_map(static fn (array $log): string => $log['db']['operation'], $entries));
        $this->assertSame('orders', $entries[1]['db']['target']);
        $this->assertStringNotContainsString('open', $entries[1]['db']['statement'], 'Values are replaced by ?');
        $this->assertStringNotContainsString('o-1', $entries[0]['db']['statement']);

        foreach ($this->writes($client) as $name => [$method, $write]) {
            $result = $this->preview($recorder, [$store], function () use ($write): void {
                try {
                    $write();
                } catch (PreviewWriteBlockedException) {
                    // A handler that swallows the refusal still gets a 409.
                }
            });
            $this->assertSame(409, $result->status, $name);
            $this->assertSame($method, $result->problem()['operation'], $name);
            $this->assertSame('firestore', $result->problem()['store']);
            $this->assertSame('Preview unavailable: this operation writes to Firestore', $result->problem()['detail']);
        }
        // BeginTransaction and Rollback hold and release a transaction and change no data: they are allowed.
        $this->assertSame(['BatchGetDocuments', 'RunQuery'], array_values(array_diff($fake->methods(), ['BeginTransaction', 'Rollback'])), 'No write may reach the network during a Preview.');
    }

    public function testABulkWriterThatFlushesAfterThePreviewHasEndedIsStillRefused(): void
    {
        // A BulkWriter batches writes and sends them on flush(), which a handler can leave to a shutdown
        // function, a destructor or an after-response callback: after the Preview ended, in the same
        // request. Every write of a PHP process during a Preview's request belongs to that Preview
        // (there are no background threads), so the scope outlives the Preview and refuses it unsent.
        [$recorder, $client, $fake, $store] = $this->hooked();
        $writer = $client->bulkWriter();
        $result = $this->preview($recorder, [$store], function () use ($writer, $client): void {
            $writer->set($client->collection('orders')->document('late'), ['status' => 'new']);
        });
        $this->assertTrue($result->isConfirmed(), 'The handler only queued the write');
        $this->assertTrue($recorder->inPreviewScope(), 'The Preview scope lasts to the end of the request');
        try {
            $writer->flush();
            $this->fail('The late flush was not refused.');
        } catch (PreviewWriteBlockedException $refusal) {
            $this->assertSame('BatchWrite', $refusal->operation);
        }
        $this->assertSame('firestore', $recorder->blocked()['store'], 'The refusal blocks the Preview');
        $this->assertSame([], $fake->sent, 'The late write was never sent');
    }

    public function testATransactionThatOnlyReadsRunsAndNothingItSendsWrites(): void
    {
        [$recorder, $client, $fake, $store] = $this->hooked();
        $result = $this->preview($recorder, [$store], fn () => $client->runTransaction(fn ($transaction) => $transaction->snapshot($client->collection('orders')->document('o-1'))));
        $this->assertTrue($result->isConfirmed(), 'A transaction that only reads is not a write');
        $this->assertSame(['BeginTransaction', 'BatchGetDocuments'], array_slice($fake->methods(), 0, 2));
        $this->assertSame([], array_values(array_intersect($fake->methods(), ['BatchWrite', 'Write', 'CreateDocument', 'UpdateDocument', 'DeleteDocument'])));
    }

    public function testTheWriteStreamIsRefusedBeforeItsFirstMessage(): void
    {
        [$recorder, , $fake, $store] = $this->hooked();
        $transport = $this->hookedTransport($recorder, $fake);
        foreach ([
            'Write' => fn () => $transport->startBidiStreamingCall(new Call('/google.firestore.v1.Firestore/Write', null, null, [], Call::BIDI_STREAMING_CALL), []),
            'Write as a client stream' => fn () => $transport->startClientStreamingCall(new Call('/google.firestore.v1.Firestore/Write', null, null, [], Call::CLIENT_STREAMING_CALL), []),
        ] as $name => $open) {
            $result = $this->preview($recorder, [$store], function () use ($open): void {
                try {
                    $open();
                } catch (PreviewWriteBlockedException) {
                }
            });
            $this->assertSame(409, $result->status, $name);
            $this->assertSame('Write', $result->problem()['operation']);
        }
        $this->assertSame([], $fake->sent);
        // Listen is a read stream and opens.
        $this->assertTrue($this->preview($recorder, [$store], fn () => $transport->startBidiStreamingCall(new Call('/google.firestore.v1.Firestore/Listen', null, null, [], Call::BIDI_STREAMING_CALL), []))->isConfirmed());
        $this->assertSame(['google.firestore.v1.Firestore/Listen'], $fake->sent);
    }

    public function testAnAdminClientIsGuardedByTheSameInstallCall(): void
    {
        $recorder = new Recorder();
        $fake = new RecordingFirestoreTransport();
        $admin = new \Google\Cloud\Firestore\Admin\V1\Client\FirestoreAdminClient(['transport' => $fake, 'credentials' => new \Google\ApiCore\CredentialsWrapper(new \Google\Auth\Credentials\InsecureCredentials())]);
        FirestoreGuard::install($admin, new Guard(static fn () => $recorder));
        $this->assertTrue($this->preview($recorder, [new GuardOnlyStore('firestore')], fn () => $admin->getField(new \Google\Cloud\Firestore\Admin\V1\GetFieldRequest(['name' => 'projects/p/databases/(default)/collectionGroups/c/fields/f'])))->isConfirmed());
        $result = $this->preview($recorder, [new GuardOnlyStore('firestore')], function () use ($admin): void {
            try {
                $admin->deleteIndex(new \Google\Cloud\Firestore\Admin\V1\DeleteIndexRequest(['name' => 'projects/p/databases/(default)/collectionGroups/c/indexes/i']));
            } catch (PreviewWriteBlockedException) {
            }
        });
        $this->assertSame(409, $result->status);
        $this->assertSame('DeleteIndex', $result->problem()['operation']);
        $this->assertSame(['google.firestore.admin.v1.FirestoreAdmin/GetField'], $fake->sent);
    }

    public function testOutsideAPreviewEveryCallIsSentAndObservedSendLogsEachOnce(): void
    {
        [$recorder, $client, $fake] = $this->hooked();
        $recorder->begin(false);
        $client->collection('orders')->document('o-1')->set(['status' => 'new']);
        $this->assertSame(['Commit'], $fake->methods());
        $db = array_values(array_filter($recorder->finish()['logs'], static fn (array $log): bool => $log['level'] === 'Db'));
        $this->assertSame(['Commit'], array_map(static fn (array $log): string => $log['db']['operation'], $db));
        $this->assertSame('orders', $db[0]['db']['target']);
        $this->assertStringNotContainsString('new', $db[0]['db']['statement'], 'Field values never reach the log');
        $this->assertStringNotContainsString('o-1', $db[0]['db']['statement']);
    }

    public function testHookingAClientTwiceLogsEachCallOnce(): void
    {
        [$recorder, $client] = $this->hooked();
        FirestoreGuard::install($client, new Guard(static fn () => $recorder));
        $recorder->begin(false);
        $client->collection('orders')->document('o-1')->set(['status' => 'new']);
        $this->assertCount(1, array_filter($recorder->finish()['logs'], static fn (array $log): bool => $log['level'] === 'Db'));
    }

    public function testBuildingTheClientWithTheGuardedTransportCoversItFromTheStart(): void
    {
        $recorder = new Recorder();
        $fake = new RecordingFirestoreTransport();
        putenv('FIRESTORE_EMULATOR_HOST=127.0.0.1:1');
        try {
            $client = new FirestoreClient(['projectId' => 'bench', 'transport' => FirestoreGuard::transport($fake, new Guard(static fn () => $recorder))]);
        } finally {
            putenv('FIRESTORE_EMULATOR_HOST');
        }
        $result = $this->preview($recorder, [new GuardOnlyStore('firestore')], function () use ($client): void {
            try {
                $client->collection('orders')->document('o-1')->delete();
            } catch (PreviewWriteBlockedException) {
            }
        });
        $this->assertSame(409, $result->status);
        $this->assertSame([], $fake->sent);
    }

    public function testHostDeclaredReadsAreExactMethodNames(): void
    {
        $recorder = new Recorder();
        $fake = new RecordingFirestoreTransport();
        $transport = new GuardedFirestoreTransport($fake, new Guard(static fn () => $recorder), Guard::readSet(['PartitionQuery']));
        $this->assertTrue($this->preview($recorder, [new GuardOnlyStore('firestore')], fn () => $transport->startServerStreamingCall(new Call('/google.firestore.v1.Firestore/FutureRead', null, null, [], Call::SERVER_STREAMING_CALL), []))->status === 409);
        $this->assertSame([], $fake->sent, 'Only the named method is a read');
    }

    public function testCommitWithNoWritesIsSessionStateAndWithoutAMessageItIsAWrite(): void
    {
        $recorder = new Recorder();
        $fake = new RecordingFirestoreTransport();
        $transport = new GuardedFirestoreTransport($fake, new Guard(static fn () => $recorder));
        $commit = static fn (?Message $message) => new Call('/google.firestore.v1.Firestore/Commit', null, $message, [], Call::UNARY_CALL);
        $this->assertTrue($this->preview($recorder, [new GuardOnlyStore('firestore')], fn () => $transport->startUnaryCall($commit(new CommitRequest()), []))->isConfirmed());
        $result = $this->preview($recorder, [new GuardOnlyStore('firestore')], function () use ($transport, $commit): void {
            try {
                $transport->startUnaryCall($commit(null), []);
            } catch (PreviewWriteBlockedException) {
            }
        });
        $this->assertSame(409, $result->status, 'A Commit the hook cannot read is a write');
        $this->assertCount(1, $fake->sent);
    }

    /** @return \Generator<string,array{0:string,1:array<string,mixed>}> */
    public static function recordedRequests(): \Generator
    {
        if (!is_file(self::RECORDINGS)) {
            return;
        }
        $file = json_decode((string) file_get_contents(self::RECORDINGS), true, 512, JSON_THROW_ON_ERROR);
        foreach ($file['recordings'] as $recording) {
            yield $recording['name'] => [$recording['name'], $recording['requests']];
        }
    }

    /**
     * @param list<array<string,mixed>> $requests
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('recordedRequests')]
    public function testEveryRecordedRequestIsClassifiedAndGuardedAsTheSpecSays(string $name, array $requests): void
    {
        $this->replay($name, $requests, hook: true);
    }

    /**
     * @param list<array<string,mixed>> $requests
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('recordedRequests')]
    public function testTheReplayFailsWhenTheHookIsRemoved(string $name, array $requests): void
    {
        $writes = array_filter($requests, static fn (array $request): bool => $request['expect']['kind'] === 'write');
        if ($writes === []) {
            $this->markTestSkipped('A recording of reads has no write assertion to fail.');
        }
        $this->expectException(AssertionFailedError::class);
        $this->replay($name, $requests, hook: false);
    }

    /**
     * Replays one recording inside a Preview, as spec/data-stores/recordings/README.md describes.
     *
     * @param list<array<string,mixed>> $requests
     */
    private function replay(string $name, array $requests, bool $hook): void
    {
        $recorder = new Recorder();
        $fake = new RecordingFirestoreTransport();
        $transport = $hook ? new GuardedFirestoreTransport($fake, new Guard(static fn () => $recorder)) : $fake;
        foreach ($requests as $request) {
            $rpc = (string) $request['rpc'];
            $method = substr($rpc, (int) strrpos($rpc, '/') + 1);
            [$class, $type] = self::REQUESTS[$method] ?? $this->fail("No request class for {$method}");
            /** @var Message $message */
            $message = new $class();
            $message->mergeFromJsonString(json_encode($request['rest']['body'] ?? new \stdClass()), true);
            $call = new Call($rpc, null, $message, [], $type);
            $label = "{$name}: {$method}";
            $before = count($fake->sent);
            $recorder->begin(true);
            $start = match ($type) {
                Call::SERVER_STREAMING_CALL => 'startServerStreamingCall',
                default => 'startUnaryCall',
            };
            $expect = $request['expect'];
            if ($expect['kind'] === 'write') {
                try {
                    // The generated client waits on a unary call's promise, which is when its entry is logged.
                    $transport->$start($call, [])?->wait();
                    $this->fail("{$label} was not refused");
                } catch (PreviewWriteBlockedException $refused) {
                    $this->assertSame('firestore', $refused->store, $label);
                    $this->assertSame($expect['operation'], $refused->operation, $label);
                }
                $this->assertCount($before, $fake->sent, "{$label} must not reach the store");
                $this->assertSame('firestore', $recorder->blocked()['store'] ?? null, "{$label} must mark the Preview blocked");
            } else {
                $reply = $transport->$start($call, []);
                $reply instanceof \GuzzleHttp\Promise\PromiseInterface && $reply->wait();
                $this->assertCount($before + 1, $fake->sent, "{$label} must reach the store");
                $db = array_values(array_filter($recorder->finish()['logs'], static fn (array $log): bool => $log['level'] === 'Db'));
                if ($expect['kind'] === 'read') {
                    $this->assertSame([$expect['operation']], array_map(static fn (array $log): string => $log['db']['operation'], $db), "{$label} must be logged");
                    $this->assertSame([], $this->stringLeaves(json_decode($db[0]['db']['statement'] ?? 'null', true), true), "{$label} must not log values");
                } else {
                    $this->assertSame([], $db, "{$label} is session state and isn't logged");
                }
            }
        }
        // Outside a Preview everything passes through, writes included.
        $recorder->begin(false);
        $open = new RecordingFirestoreTransport();
        $outside = new GuardedFirestoreTransport($open, new Guard(static fn () => $recorder));
        $sent = 0;
        foreach ($requests as $request) {
            $rpc = (string) $request['rpc'];
            [$class, $type] = self::REQUESTS[substr($rpc, (int) strrpos($rpc, '/') + 1)];
            $message = new $class();
            $message->mergeFromJsonString(json_encode($request['rest']['body'] ?? new \stdClass()), true);
            $outside->{$type === Call::SERVER_STREAMING_CALL ? 'startServerStreamingCall' : 'startUnaryCall'}(new Call($rpc, null, $message, [], $type), []);
            $sent++;
        }
        $this->assertCount($sent, $open->sent, 'Outside a Preview every request reaches the transport');
    }

    /**
     * The scalar values of a decoded statement that are not the placeholder `?`.
     *
     * @return list<string>
     */
    private function stringLeaves(mixed $value, bool $root = false): array
    {
        if (is_array($value)) {
            return array_merge([], ...array_map(fn ($inner) => $this->stringLeaves($inner), array_values($value)));
        }

        return $root || $value === '?' || $value === null ? [] : [(string) json_encode($value)];
    }

    private function hookedTransport(Recorder $recorder, RecordingFirestoreTransport $fake): GuardedFirestoreTransport
    {
        return new GuardedFirestoreTransport($fake, new Guard(static fn () => $recorder));
    }
}
