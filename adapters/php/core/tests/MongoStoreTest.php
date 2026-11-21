<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use MongoDB\Client;
use MongoDB\Driver\Command;
use PHPUnit\Framework\TestCase;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Preview\CapturedResponse;
use Sendproof\Core\Stores\Guard;
use Sendproof\Core\Stores\MongoDb\GuardedClient;
use Sendproof\Core\Stores\MongoDb\GuardedCollection;
use Sendproof\Core\Stores\MongoDb\GuardedDatabase;
use Sendproof\Core\Stores\MongoDb\MongoEngine;
use Sendproof\Core\Stores\MongoDb\MongoHook;
use Sendproof\Core\Stores\MongoDb\MongoStore;
use Sendproof\Core\Stores\PreviewTransactionControlException;
use Sendproof\Core\Stores\PreviewWriteBlockedException;
use Sendproof\Core\Tests\Support\RunsPreviews;
use Sendproof\Core\Tests\Support\Services;

/**
 * MongoDB in Preview (spec/data-stores.md "MongoDB in Preview"), against the replica set of
 * tests/conformance/compose.yml: the session binding, the tripwire, snapshot-time before images,
 * the guard mode of a standalone server and the Preview time limit.
 */
final class MongoStoreTest extends TestCase
{
    use RunsPreviews;

    private string $database;
    private Client $raw;
    private Client $independent;

    protected function setUp(): void
    {
        Services::need('mongodb');
        $this->database = 'php_core_' . bin2hex(random_bytes(4));
        $this->raw = new Client(Services::mongodbUrl() . '&appName=hooked');
        // A second client stands in for "another request". The driver pools clients by their constructor
        // arguments, and monitoring sees every command of a pooled client, so it needs its own appName.
        $this->independent = new Client(Services::mongodbUrl() . '&appName=independent');
        $this->independent->selectCollection($this->database, 'documents')->insertOne([
            '_id' => 'seeded', 'name' => 'Seeded', 'profile' => ['city' => 'Leeds'], 'password_hash' => 'hashed:seeded',
        ]);
    }

    protected function tearDown(): void
    {
        if (isset($this->independent)) {
            $this->independent->dropDatabase($this->database);
        }
    }

    /** @return array{0:Recorder,1:GuardedClient,2:MongoStore,3:MongoEngine} */
    private function hooked(?callable $hello = null, int $timeoutMs = MongoEngine::DEFAULT_TIMEOUT_MS): array
    {
        $recorder = new Recorder();
        $engine = new MongoEngine($this->raw->getManager(), new Guard(static fn () => $recorder), null, $timeoutMs, $hello);

        return [$recorder, new GuardedClient($this->raw, new MongoHook($engine)), new MongoStore($engine, 'catalog'), $engine];
    }

    private function documents(string $name = 'documents'): \MongoDB\Collection
    {
        return $this->independent->selectCollection($this->database, $name);
    }

    public function testAPreviewRunsInOneTransactionReportsNestedRedactedChangesAndRollsBack(): void
    {
        [$recorder, $client, $store] = $this->hooked();
        $this->assertSame(['system' => 'mongodb', 'name' => 'catalog', 'mode' => 'preview'], $store->describe());

        $result = $this->preview($recorder, [$store], function () use ($client): void {
            $collection = $client->selectCollection($this->database, 'documents');
            $collection->insertOne(['_id' => 'draft', 'name' => 'Draft', 'profile' => ['city' => 'York'], 'password_hash' => 'hashed:x']);
            $collection->updateOne(['_id' => 'seeded'], ['$set' => ['name' => 'Renamed', 'profile.city' => 'Hull']]);
            $collection->replaceOne(['_id' => 'seeded'], ['name' => 'Replaced', 'apiKey' => 'secret-key']);
            $collection->updateOne(['_id' => 'upserted'], ['$set' => ['name' => 'Up']], ['upsert' => true]);
            $this->assertSame('Draft', $collection->findOne(['_id' => 'draft'])['name'], 'The handler reads its own write inside the transaction.');
        });

        $this->assertTrue($result->isConfirmed());
        $changes = [];
        foreach ($result->envelope['changes'] as $change) {
            $changes[$change['key']['_id'] . ':' . $change['operation']] = $change;
        }
        $this->assertSame('York', $changes['draft:insert']['after']['profile']['city']);
        $this->assertNull($changes['draft:insert']['before']);
        $this->assertSame('[REDACTED]', $changes['draft:insert']['after']['password_hash']);
        $this->assertSame('mongodb', $changes['draft:insert']['store']);
        $this->assertSame('documents', $changes['draft:insert']['table']);
        // The replacement and the upsert carry how they were made, and secret fields stay hidden at any depth.
        $this->assertSame('replace', $changes['seeded:update']['via']);
        $this->assertSame('[REDACTED]', $changes['seeded:update']['after']['apiKey']);
        $this->assertSame('Leeds', $changes['seeded:update']['before']['profile']['city']);
        $this->assertSame('upsert', $changes['upserted:insert']['via']);

        $this->assertNull($this->documents()->findOne(['_id' => 'draft']), 'An independent read must not see the Preview insert.');
        $this->assertSame('Seeded', $this->documents()->findOne(['_id' => 'seeded'])['name']);
        $this->assertFalse(str_contains(json_encode($result->envelope), 'hashed:x'));
        $writes = array_filter($result->envelope['logs'], static fn (array $entry): bool => ($entry['db']['operation'] ?? '') === 'insert');
        $this->assertNotEmpty($writes);
        $this->assertSame('documents', reset($writes)['db']['target']);
    }

    public function testAnAggregateOutOrMergeAtAnyDepthAndExplicitCreateAreBlockedBeforeSending(): void
    {
        [$recorder, $client, $store] = $this->hooked();
        $collection = $client->selectCollection($this->database, 'documents');
        foreach ([
            'out' => static fn () => iterator_to_array($collection->aggregate([['$match' => new \stdClass()], ['$out' => 'archive']])),
            'merge in a facet' => static fn () => iterator_to_array($collection->aggregate([['$facet' => ['a' => [['$merge' => ['into' => 'archive']]]]]])),
            'create' => fn () => $client->selectDatabase($this->database)->createCollection('made'),
            'count' => static fn () => $collection->count(),
        ] as $label => $call) {
            $result = $this->preview($recorder, [$store], function () use ($call): void {
                try {
                    $call();
                } catch (PreviewWriteBlockedException) {
                    // The handler swallows the refusal; the mark still decides.
                }
            });
            $this->assertSame(409, $result->status, $label);
            $this->assertMatchesRegularExpression('/can\'t run .* inside a transaction/', $result->problem()['detail'], $label);
        }
        $this->assertNull($this->documents('archive')->findOne([]), '$out must not write the archive collection.');
        $this->assertNotContains('made', iterator_to_array($this->independent->selectDatabase($this->database)->listCollectionNames()));
    }

    public function testAWriteSentWithoutThePreviewSessionFailsThePreviewWith500(): void
    {
        [$recorder, $client, $store] = $this->hooked();
        $result = $this->preview($recorder, [$store], function () use ($client): void {
            $client->selectCollection($this->database, 'documents')->insertOne(['_id' => 'in-preview']);
            // The raw manager has no hook: this write escapes the transaction and commits.
            $bulk = new \MongoDB\Driver\BulkWrite();
            $bulk->insert(['_id' => 'escaped']);
            $this->raw->getManager()->executeBulkWrite($this->database . '.documents', $bulk);
        });

        $this->assertSame(500, $result->status);
        $this->assertNull($result->envelope, 'A write that escaped the session must never be confirmed.');
        $this->assertNotNull($this->documents()->findOne(['_id' => 'escaped']), 'The escape could not be undone, which is why it is never confirmed.');
        $this->documents()->deleteOne(['_id' => 'escaped']);
    }

    public function testAForeignSessionAndAHandlerCommitAreRefusedAndFailThePreview(): void
    {
        [$recorder, $client, $store] = $this->hooked();
        foreach ([
            'foreign session' => fn () => $client->selectCollection($this->database, 'documents')->insertOne(['_id' => 'f'], ['session' => $this->raw->startSession()]),
            'commitTransaction command' => fn () => $client->selectDatabase($this->database)->command(['commitTransaction' => 1]),
            'abortTransaction command' => fn () => $client->selectDatabase('admin')->command(['abortTransaction' => 1]),
        ] as $label => $call) {
            $result = $this->preview($recorder, [$store], function () use ($call): void {
                try {
                    $call();
                } catch (PreviewTransactionControlException) {
                    // Caught, and the Preview still answers 500.
                }
            });
            $this->assertSame(500, $result->status, $label);
            $this->assertNull($result->envelope, $label);
        }
        $this->assertNull($this->documents()->findOne(['_id' => 'f']));
    }

    public function testACommitThatReachedTheServerBeforeOrAfterTheHandlerCatchesItNeverConfirms(): void
    {
        [$recorder, $client, $store] = $this->hooked();
        $result = $this->preview($recorder, [$store], function () use ($client): void {
            $client->selectCollection($this->database, 'documents')->insertOne(['_id' => 'doomed']);
            // Around the hook: the unguarded manager sends commitTransaction with no session of its own.
            try {
                $this->raw->getManager()->executeCommand('admin', new Command(['commitTransaction' => 1]));
            } catch (\Throwable) {
                // The server may reject it; the monitor saw it either way.
            }
        });
        $this->assertSame(500, $result->status);
    }

    public function testTheHandlersOwnTransactionJoinsThePreviewAndItsCommitNeverReachesTheServer(): void
    {
        [$recorder, $client, $store] = $this->hooked();
        $result = $this->preview($recorder, [$store], function () use ($client): void {
            $session = $client->startSession();
            $collection = $client->selectCollection($this->database, 'documents');
            \MongoDB\with_transaction($session, function ($session) use ($collection): void {
                $collection->insertOne(['_id' => 'joined', 'name' => 'Joined'], ['session' => $session]);
            });
            $session->startTransaction();
            $collection->insertOne(['_id' => 'joined-two'], ['session' => $session]);
            $session->commitTransaction();
        });
        $this->assertTrue($result->isConfirmed(), 'A handler that wraps its work in its own transaction still gets a Preview.');
        $inserted = array_map(static fn (array $change): string => $change['key']['_id'], $result->envelope['changes']);
        $this->assertEqualsCanonicalizing(['joined', 'joined-two'], $inserted);
        $this->assertNull($this->documents()->findOne(['_id' => 'joined']));
        $this->assertNull($this->documents()->findOne(['_id' => 'joined-two']));
    }

    public function testBeforeImagesComeFromTheTransactionStartNotFromLaterCommitsByOthers(): void
    {
        [$recorder, $client, $store] = $this->hooked();
        $result = $this->preview($recorder, [$store], function () use ($client): void {
            // The snapshot is taken here, by the first command of the transaction.
            $client->selectCollection($this->database, 'documents')->updateMany([], ['$set' => ['touched' => true]]);
            // Another request commits now. A majority-committed read would see this document as a Preview "delete".
            $this->documents()->insertOne(['_id' => 'concurrent', 'name' => 'Theirs']);
        });
        $this->assertTrue($result->isConfirmed());
        $keys = array_map(static fn (array $change): string => $change['key']['_id'] . ':' . $change['operation'], $result->envelope['changes']);
        $this->assertSame(['seeded:update'], $keys, 'A document another request inserted must not appear as a delete.');
        $change = $result->envelope['changes'][0];
        $this->assertSame('Leeds', $change['before']['profile']['city'], "The before image is the committed state at the transaction's start.");
        $this->assertArrayNotHasKey('touched', $change['before']);
        $this->assertTrue($change['after']['touched']);
        $this->documents()->deleteOne(['_id' => 'concurrent']);
    }

    public function testAStandaloneServerRunsInGuardModeAndABlockedWriteNeverReachesIt(): void
    {
        $standalone = static fn (): object => (object) ['isWritablePrimary' => true, 'maxWireVersion' => 27];
        [$recorder, $client, $store] = $this->hooked($standalone);
        $this->assertSame(['system' => 'mongodb', 'name' => 'catalog', 'mode' => 'guard', 'reason' => MongoEngine::STANDALONE_REASON], $store->describe());

        $read = $this->preview($recorder, [$store], fn () => $client->selectCollection($this->database, 'documents')->findOne(['_id' => 'seeded']));
        $this->assertTrue($read->isConfirmed(), 'Reads run normally in guard mode.');

        $write = $this->preview($recorder, [$store], function () use ($client): void {
            try {
                $client->selectCollection($this->database, 'documents')->insertOne(['_id' => 'guarded']);
            } catch (PreviewWriteBlockedException) {
            }
        });
        $this->assertSame(409, $write->status);
        $this->assertSame(['store' => 'mongodb', 'operation' => 'insert'], array_intersect_key($write->problem(), ['store' => 1, 'operation' => 1]));
        $this->assertNull($this->documents()->findOne(['_id' => 'guarded']));
    }

    public function testAPreviewKeepsTheModeItBeganInWhenDetectionLaterSucceeds(): void
    {
        $calls = 0;
        $flaky = static function () use (&$calls): object {
            if ($calls++ === 0) {
                throw new \RuntimeException('server unreachable');
            }

            return (object) ['setName' => 'rs0', 'logicalSessionTimeoutMinutes' => 30];
        };
        [$recorder, $client, $store, $engine] = $this->hooked($flaky);

        $result = $this->preview($recorder, [$store], function () use ($client, $engine, $store): void {
            // Detection failed when this Preview began, so it is in guard mode; a later success must not change that.
            $this->assertSame('preview', $engine->detect()['mode']);
            try {
                $client->selectCollection($this->database, 'documents')->insertOne(['_id' => 'late']);
            } catch (PreviewWriteBlockedException) {
            }
        });
        $this->assertSame(409, $result->status, 'A Preview that began in guard mode never treats its writes as joining a transaction.');
        $this->assertNull($this->documents()->findOne(['_id' => 'late']));
    }

    public function testAPreviewThatOutlivesItsTimeLimitIsAbortedAndNeverConfirmed(): void
    {
        [$recorder, $client, $store] = $this->hooked(null, 30);
        $result = $this->preview($recorder, [$store], function () use ($client): void {
            $collection = $client->selectCollection($this->database, 'documents');
            $collection->insertOne(['_id' => 'slow-one']);
            usleep(80_000);
            try {
                $collection->insertOne(['_id' => 'slow-two']);
            } catch (PreviewTransactionControlException) {
                // The transaction was aborted at the limit.
            }
        });
        $this->assertSame(500, $result->status);
        $this->assertNull($this->documents()->findOne(['_id' => 'slow-one']));

        // A handler that finishes without another command is judged at the end.
        [$recorder, $client, $store] = $this->hooked(null, 30);
        $late = $this->preview($recorder, [$store], function () use ($client): void {
            $client->selectCollection($this->database, 'documents')->insertOne(['_id' => 'slow-three']);
            usleep(80_000);
        });
        $this->assertSame(500, $late->status);
    }

    public function testSecretsNeverReachTheLogAndSessionCommandsAreNotLogged(): void
    {
        [$recorder, $client, $store] = $this->hooked();
        $result = $this->preview($recorder, [$store], function () use ($client): void {
            $client->selectCollection($this->database, 'documents')->insertOne(['_id' => 'logged', 'password_hash' => 'hashed:super-secret', 'name' => 'Visible name']);
        });
        $text = json_encode($result->envelope['logs']);
        $this->assertStringNotContainsString('hashed:super-secret', $text);
        $this->assertStringNotContainsString('Visible name', $text, 'A Db statement keeps field names and operators, never values.');
        $this->assertStringContainsString('"documents":[{"_id":"?"', str_replace('\\', '', $text));
        foreach ($result->envelope['logs'] as $entry) {
            $this->assertNotContains(strtolower($entry['db']['operation'] ?? ''), ['hello', 'ismaster', 'saslstart', 'endsessions']);
        }
    }

    public function testObservedSendIsNeverBlockedAndTracesDbEntries(): void
    {
        [$recorder, $client] = $this->hooked();
        $recorder->begin(false);
        $client->selectCollection($this->database, 'documents')->insertOne(['_id' => 'sent', 'name' => 'Sent']);
        $capture = $recorder->finish();
        $this->assertNotNull($this->documents()->findOne(['_id' => 'sent']), 'Send commits normally.');
        $this->assertSame(['insert'], array_values(array_map(static fn (array $entry): string => $entry['db']['operation'], array_filter($capture['logs'], static fn (array $entry): bool => $entry['level'] === 'Db'))));
    }

    public function testTheGuardChecksFailWhenTheHookIsRemoved(): void
    {
        // The negative test: the same write through the unhooked client escapes the Preview, so a binding that skipped the hook fails these checks.
        [$recorder, , $store] = $this->hooked();
        $result = $this->preview($recorder, [$store], function (): void {
            $this->raw->selectCollection($this->database, 'documents')->insertOne(['_id' => 'unhooked']);
        });
        $this->assertSame(500, $result->status, 'An unhooked write is caught only by the tripwire.');
        $this->assertNotNull($this->documents()->findOne(['_id' => 'unhooked']));
        $this->documents()->deleteOne(['_id' => 'unhooked']);
    }

    public function testEveryLibraryMethodIsEitherGuardedOrListedAsInert(): void
    {
        // Fails closed when mongodb/mongodb grows a method this binding has not seen.
        foreach ([[Client::class, GuardedClient::class], [\MongoDB\Database::class, GuardedDatabase::class], [\MongoDB\Collection::class, GuardedCollection::class]] as [$library, $guarded]) {
            foreach ((new \ReflectionClass($library))->getMethods(\ReflectionMethod::IS_PUBLIC) as $method) {
                if ($method->isFinal() || $method->isStatic() || in_array($method->getName(), ['addSubscriber', 'removeSubscriber'], true)) {
                    continue;
                }
                $overridden = (new \ReflectionMethod($guarded, $method->getName()))->getDeclaringClass()->getName() === $guarded;
                $this->assertTrue($overridden || in_array($method->getName(), $guarded::INERT, true), "{$library}::{$method->getName()} is neither guarded nor inert in {$guarded}.");
            }
        }
    }

    public function testAMethodOutsideTheRuleTableIsRefusedInAPreview(): void
    {
        [$recorder, $client] = $this->hooked();
        $recorder->begin(true);
        $this->expectException(PreviewWriteBlockedException::class);
        $client->selectDatabase($this->database)->getGridFSBucket();
    }

    public function testAPreviewResponseIsBuiltFromTheHandlerNotFromTheStore(): void
    {
        [$recorder, $client, $store] = $this->hooked();
        $result = $this->preview($recorder, [$store], static fn (): CapturedResponse => new CapturedResponse(201, ['Content-Type' => 'application/json'], '{"id":"x"}'));
        $this->assertSame(201, $result->envelope['status']);
        $this->assertTrue($result->envelope['rolledBack']);
    }
}
