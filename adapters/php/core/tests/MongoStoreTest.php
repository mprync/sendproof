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

    /**
     * The documents collection through a client that gives up after 3 seconds. A write that meets an
     * open transaction's lock waits for the transaction to end, ignoring `maxTimeMS`, so only a
     * socket timeout shows that a transaction was left open.
     */
    private function impatient(): \MongoDB\Collection
    {
        return (new Client(Services::mongodbUrl() . '&appName=impatient&socketTimeoutMS=3000'))->selectCollection($this->database, 'documents');
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

    public function testARollbackOfTheHandlersJoinedTransactionCannotBeHonouredSoThePreviewFails(): void
    {
        [$recorder, $client, $store] = $this->hooked();
        $result = $this->preview($recorder, [$store], function () use ($client): void {
            $session = $client->startSession();
            $session->startTransaction();
            $client->selectCollection($this->database, 'documents')->insertOne(['_id' => 'discarded'], ['session' => $session]);
            $session->abortTransaction();
        });
        $this->assertSame(500, $result->status, 'MongoDB has no savepoints, so a part of the Preview transaction cannot be undone.');
        $this->assertNull($this->documents()->findOne(['_id' => 'discarded']));
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

    /**
     * Code that runs after the Preview ended but still in its request (a terminating callback, an
     * after-response job run inline) is refused with the Preview's own error, never sent on the
     * ended session or without one.
     */
    public function testACallMadeOnceThePreviewHasEndedIsRefusedNeverSent(): void
    {
        [$recorder, $client, $store] = $this->hooked();
        $collection = $client->selectCollection($this->database, 'documents');
        $result = $this->preview($recorder, [$store], function () use ($collection): void {
            $collection->insertOne(['_id' => 'inside']);
        });
        $this->assertSame(200, $result->status);
        foreach ([fn () => $collection->insertOne(['_id' => 'late']), fn () => $collection->findOne(['_id' => 'inside'])] as $late) {
            try {
                $late();
                $this->fail('A call after the Preview ended must be refused.');
            } catch (PreviewTransactionControlException $error) {
                $this->assertStringContainsString('has ended', $error->getMessage());
            }
        }
        $this->assertNull($this->documents()->findOne(['_id' => 'late']));
        $this->assertNull($this->documents()->findOne(['_id' => 'inside']));
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

    public function testTwoHookedClientsOnOneUriShareMonitoringWithoutFailingEachOther(): void
    {
        // The driver pools both clients, so each engine's monitor sees the other's commands.
        $recorder = new Recorder();
        $guard = new Guard(static fn () => $recorder);
        $url = Services::mongodbUrl() . '&appName=pooled';
        $one = MongoStore::hook(new Client($url), $guard, 'one');
        $two = MongoStore::hook(new Client($url), $guard, 'two');
        $result = $this->preview($recorder, [$one, $two], function () use ($one, $two): void {
            $one->client()->selectCollection($this->database, 'documents')->insertOne(['_id' => 'from-one']);
            $two->client()->selectCollection($this->database, 'documents')->insertOne(['_id' => 'from-two']);
        });
        $this->assertTrue($result->isConfirmed(), 'Neither engine may take the other\'s Preview writes or abort for an escape.');
        $keys = array_map(static fn (array $change): string => $change['key']['_id'], $result->envelope['changes']);
        $this->assertEqualsCanonicalizing(['from-one', 'from-two'], $keys);
        $inserts = array_filter($result->envelope['logs'], static fn (array $entry): bool => ($entry['db']['operation'] ?? '') === 'insert');
        $this->assertCount(2, $inserts, 'A pooled command is logged once, not once per engine.');
        $this->assertNull($this->documents()->findOne(['_id' => 'from-two']));

        // An unhooked client on the same URI really escaped: its write commits, so the Preview never confirms.
        $escaped = $this->preview($recorder, [$one], function () use ($url): void {
            (new Client($url))->selectCollection($this->database, 'documents')->insertOne(['_id' => 'pooled-escape']);
        });
        $this->assertSame(500, $escaped->status);
        $this->documents()->deleteOne(['_id' => 'pooled-escape']);
    }

    public function testAWriteWithThePreviewLsidButOutsideItsTransactionTripsTheWire(): void
    {
        // The tripwire needs autocommit: false as well as the lsid: the same session outside its transaction commits.
        [$recorder, $client, $store, $engine] = $this->hooked();
        $result = $this->preview($recorder, [$store], function () use ($client, $engine): void {
            $client->selectCollection($this->database, 'documents')->insertOne(['_id' => 'inside']);
            $session = $engine->state()->session;
            $engine->internal(static fn () => $session->abortTransaction());
            $bulk = new \MongoDB\Driver\BulkWrite();
            $bulk->insert(['_id' => 'autocommitted']);
            $this->raw->getManager()->executeBulkWrite($this->database . '.documents', $bulk, ['session' => $session]);
        });
        $this->assertSame(500, $result->status);
        $this->assertNotNull($this->documents()->findOne(['_id' => 'autocommitted']), 'The write committed, which is why it is never confirmed.');
        $this->documents()->deleteOne(['_id' => 'autocommitted']);
    }

    public function testAPreviewWithoutAProvenMonitorNeverRuns(): void
    {
        [$recorder, $client, $store, $engine] = $this->hooked();
        $monitor = (new \ReflectionProperty(MongoEngine::class, 'monitor'))->getValue($engine);
        $engine->manager->removeSubscriber($monitor);
        $this->assertSame(MongoEngine::UNMONITORED_REASON, $store->describe()['reason'] ?? null);
        $result = $this->preview($recorder, [$store], fn () => $client->selectCollection($this->database, 'documents')->findOne([]));
        $this->assertSame(500, $result->status, 'Without its own monitor the engine could not see an escaped write, so it never claims a rollback.');
    }

    public function testAnUnfinishedPreviewTransactionIsAbortedWhenTheNextPreviewBegins(): void
    {
        // A worker that survived a Preview which never reached finish() (a fatal error) must not keep its transaction.
        [, $client, $store] = $this->hooked();
        $abandoned = new Recorder();
        $guard = new Guard(static fn () => $abandoned);
        $engine = new MongoEngine($this->raw->getManager(), $guard);
        $hooked = new GuardedClient($this->raw, new MongoHook($engine));
        $abandoned->begin(true);
        $engine->begin($abandoned);
        $hooked->selectCollection($this->database, 'documents')->updateOne(['_id' => 'seeded'], ['$set' => ['name' => 'Abandoned']]);

        $next = new Recorder();
        $abandoned->forget();
        $next->begin(true);
        $engine->begin($next);
        $engine->finish($next);
        $next->finish();

        $this->impatient()->updateOne(['_id' => 'seeded'], ['$set' => ['name' => 'Free']]);
        $this->assertSame('Free', $this->documents()->findOne(['_id' => 'seeded'])['name'], 'The abandoned transaction released its lock and wrote nothing.');
    }

    public function testATransactionIsAbortedWhenThePreviewProcessExitsOrDiesOfAFatalError(): void
    {
        foreach (['exit', 'fatal'] as $ending) {
            $code = sprintf(<<<'PHP'
                require %s;
                $recorder = new Sendproof\Core\Capture\Recorder();
                $store = Sendproof\Core\Stores\MongoDb\MongoStore::hook(new MongoDB\Client(%s), new Sendproof\Core\Stores\Guard(static fn () => $recorder));
                $recorder->begin(true);
                $store->begin($recorder);
                $store->client()->selectCollection(%s, 'documents')->updateOne(['_id' => 'seeded'], ['$set' => ['name' => 'Dying']]);
                echo "locked\n";
                if (%s === 'exit') { exit(0); }
                ini_set('memory_limit', '16M');
                $grow = str_repeat('x', 64000000);
                PHP, var_export(realpath(__DIR__ . '/../vendor/autoload.php'), true), var_export(Services::mongodbUrl() . '&appName=dying', true), var_export($this->database, true), var_export($ending, true));
            $output = (string) shell_exec(escapeshellarg(PHP_BINARY) . ' -r ' . escapeshellarg($code) . ' 2>&1');
            $this->assertStringContainsString('locked', $output, $ending);
            $this->impatient()->updateOne(['_id' => 'seeded'], ['$set' => ['name' => 'After ' . $ending]]);
            $this->assertSame('After ' . $ending, $this->documents()->findOne(['_id' => 'seeded'])['name'], "{$ending}: the transaction was aborted and its lock released.");
        }
    }

    public function testDerivedHandlesStayGuarded(): void
    {
        $standalone = static fn (): object => (object) ['isWritablePrimary' => true, 'maxWireVersion' => 27];
        [$recorder, $client, $store] = $this->hooked($standalone);
        $majority = ['writeConcern' => new \MongoDB\Driver\WriteConcern(\MongoDB\Driver\WriteConcern::MAJORITY)];
        foreach ([
            'collection withOptions' => fn () => $client->selectCollection($this->database, 'documents')->withOptions($majority),
            'database withOptions' => fn () => $client->selectDatabase($this->database)->withOptions($majority)->selectCollection('documents'),
            'getDatabase with options' => fn () => $client->getDatabase($this->database, $majority)->getCollection('documents', $majority),
            'getCollection with options' => fn () => $client->getCollection($this->database, 'documents', $majority),
        ] as $label => $derive) {
            $result = $this->preview($recorder, [$store], function () use ($derive): void {
                try {
                    $derive()->insertOne(['_id' => 'derived']);
                } catch (PreviewWriteBlockedException) {
                }
            });
            $this->assertSame(409, $result->status, $label);
        }
        $this->assertNull($this->documents()->findOne(['_id' => 'derived']));
    }

    public function testTheQueryLogSubscriberOfLaravelMongodbReachesTheManagerThatSendsTheCommands(): void
    {
        [, $client] = $this->hooked();
        $subscriber = new class () implements \MongoDB\Driver\Monitoring\CommandSubscriber {
            public array $seen = [];

            public function commandStarted(\MongoDB\Driver\Monitoring\CommandStartedEvent $event): void
            {
                $this->seen[] = $event->getCommandName();
            }

            public function commandSucceeded(\MongoDB\Driver\Monitoring\CommandSucceededEvent $event): void
            {
            }

            public function commandFailed(\MongoDB\Driver\Monitoring\CommandFailedEvent $event): void
            {
            }
        };
        $client->addSubscriber($subscriber);
        $client->selectCollection($this->database, 'documents')->findOne(['_id' => 'seeded']);
        $client->removeSubscriber($subscriber);
        $this->assertContains('find', $subscriber->seen);
        $this->assertSame($this->raw->getManager(), $client->getManager());
    }

    public function testGridFsIsRefusedInPreviewModeBecauseItsWritesCantJoinTheTransaction(): void
    {
        // A bucket builds its own collections around the driver's manager, so its writes would commit outside the Preview.
        [$recorder, $client, $store] = $this->hooked();
        $result = $this->preview($recorder, [$store], function () use ($client): void {
            try {
                $client->selectDatabase($this->database)->selectGridFSBucket()->uploadFromStream('notes.txt', fopen('data://text/plain,hello', 'r'));
            } catch (PreviewWriteBlockedException) {
            }
        });
        $this->assertSame(409, $result->status);
        $this->assertStringContainsString('GridFS', $result->problem()['detail']);
        $this->assertSame(0, $this->documents('fs.files')->countDocuments(), 'No GridFS file may reach the server.');
    }

    public function testTheLibraryFactoryHooksAClientForPlainUse(): void
    {
        $recorder = new Recorder();
        $store = MongoStore::hook($this->raw, new Guard(static fn () => $recorder), 'catalog');
        $this->assertInstanceOf(GuardedClient::class, $store->client());
        $result = $this->preview($recorder, [$store], fn () => $store->client()->selectCollection($this->database, 'documents')->insertOne(['_id' => 'plain']));
        $this->assertTrue($result->isConfirmed());
        $this->assertSame('plain', $result->envelope['changes'][0]['key']['_id']);
        $this->assertNull($this->documents()->findOne(['_id' => 'plain']));
    }

    public function testAPreviewResponseIsBuiltFromTheHandlerNotFromTheStore(): void
    {
        [$recorder, $client, $store] = $this->hooked();
        $result = $this->preview($recorder, [$store], static fn (): CapturedResponse => new CapturedResponse(201, ['Content-Type' => 'application/json'], '{"id":"x"}'));
        $this->assertSame(201, $result->envelope['status']);
        $this->assertTrue($result->envelope['rolledBack']);
    }

    // ---- Detection reasons ----

    public function testAnUnreachableServerHasItsOwnGuardReasonAndIsAskedAgain(): void
    {
        $this->assertNotSame(MongoEngine::STANDALONE_REASON, MongoEngine::UNREACHABLE_REASON);
        $this->assertSame("Preview unavailable: couldn't reach MongoDB to check whether it supports transactions, so this Preview runs in guard mode", MongoEngine::UNREACHABLE_REASON);
        $this->assertSame("Preview unavailable: this MongoDB server doesn't support transactions", MongoEngine::STANDALONE_REASON);

        // Nothing listens on port 1: the hello can't be sent.
        $recorder = new Recorder();
        $nowhere = MongoStore::hook(new Client('mongodb://127.0.0.1:1/?directConnection=true&serverSelectionTimeoutMS=300&connectTimeoutMS=300'), new Guard(static fn () => $recorder), 'nowhere');
        $this->assertSame(['system' => 'mongodb', 'name' => 'nowhere', 'mode' => 'guard', 'reason' => MongoEngine::UNREACHABLE_REASON], $nowhere->describe());

        // A hello that fails, then answers: guard mode with the unreachable reason, then preview mode.
        $calls = 0;
        $flaky = static function () use (&$calls): object {
            if ($calls++ === 0) {
                throw new \MongoDB\Driver\Exception\ConnectionTimeoutException('No suitable servers found');
            }

            return (object) ['setName' => 'rs0', 'logicalSessionTimeoutMinutes' => 30];
        };
        [, , $store] = $this->hooked($flaky);
        $this->assertSame(MongoEngine::UNREACHABLE_REASON, $store->describe()['reason'] ?? null);
        $this->assertSame(['system' => 'mongodb', 'name' => 'catalog', 'mode' => 'preview'], $store->describe());
    }

    // ---- An abort the server never acknowledged ----

    /**
     * A second transaction that writes the seeded document, retried while a Preview transaction still
     * holds its lock (a transaction waits only 5 ms for one, then gets a WriteConflict).
     */
    private function writtenInASecondTransactionWithin(float $seconds): bool
    {
        $deadline = microtime(true) + $seconds;
        $collection = $this->documents();
        while (true) {
            $session = $this->independent->startSession();
            try {
                $session->startTransaction(['writeConcern' => new \MongoDB\Driver\WriteConcern(\MongoDB\Driver\WriteConcern::MAJORITY)]);
                $collection->updateOne(['_id' => 'seeded'], ['$set' => ['name' => 'Second']], ['session' => $session]);
                $session->commitTransaction();

                return true;
            } catch (\MongoDB\Driver\Exception\Exception) {
                try {
                    if ($session->isInTransaction()) {
                        $session->abortTransaction();
                    }
                } catch (\MongoDB\Driver\Exception\Exception) {
                }
                if (microtime(true) > $deadline) {
                    return false;
                }
                usleep(200_000);
            } finally {
                $session->endSession();
            }
        }
    }

    /**
     * The network fails as the engine starts its abort and stays down for 3 seconds. The Preview runs
     * in its own process (tests/Support/lost-abort-preview.php), as a request would, so the binding's
     * shutdown work runs once it has answered.
     */
    public function testAPreviewWhoseAbortIsLostAnswers500AtOnceAndItsLocksAreReleased(): void
    {
        $pipes = [];
        [, $host, $port] = preg_match('#mongodb://(?:[^@/]*@)?([^:/,]+):(\d+)#', Services::mongodbUrl(), $match) === 1 ? $match : [null, '127.0.0.1', '57017'];
        $proxy = proc_open([PHP_BINARY, __DIR__ . '/Support/mongo-proxy.php', $host, $port], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $this->assertIsResource($proxy);
        try {
            [$proxyPort, $controlPort] = explode(' ', trim((string) fgets($pipes[1])));
            $child = [];
            $preview = proc_open([PHP_BINARY, __DIR__ . '/Support/lost-abort-preview.php', $proxyPort, $controlPort, $this->database, '3'], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $child);
            $this->assertIsResource($preview);
            $line = (string) fgets($child[1]);
            $outcome = json_decode($line, true);
            $this->assertIsArray($outcome, $line . stream_get_contents($child[2]));
            $this->assertTrue($outcome['cut'], 'The network was cut as the abort started.');
            $this->assertSame(500, $outcome['status'], 'A rollback the server never acknowledged is never claimed.');
            $this->assertFalse($outcome['confirmed']);
            $this->assertLessThan(2.5, $outcome['secondsAfterCut'], 'The reply waited for the network to come back.');

            // Once the network is back, the killSessions the process runs after answering frees the lock.
            $this->assertTrue($this->writtenInASecondTransactionWithin(20), 'The Preview transaction still holds its lock.');
            $this->assertSame('Second', $this->documents()->findOne(['_id' => 'seeded'])['name'], 'Nothing of the Preview was committed.');
            fclose($child[0]);
            $errors = stream_get_contents($child[2]);
            $this->assertSame(0, proc_close($preview), $errors);
            $this->assertStringNotContainsString("couldn't end a MongoDB Preview transaction", $errors);
        } finally {
            fclose($pipes[0]);
            proc_close($proxy);
        }
    }

    public function testANormalPreviewSendsNoKillSessions(): void
    {
        $names = new class implements \MongoDB\Driver\Monitoring\CommandSubscriber {
            /** @var list<string> */
            public array $names = [];

            public function commandStarted(\MongoDB\Driver\Monitoring\CommandStartedEvent $event): void
            {
                $this->names[] = $event->getCommandName();
            }

            public function commandSucceeded(\MongoDB\Driver\Monitoring\CommandSucceededEvent $event): void
            {
            }

            public function commandFailed(\MongoDB\Driver\Monitoring\CommandFailedEvent $event): void
            {
            }
        };
        [$recorder, $client, $store] = $this->hooked();
        $this->raw->getManager()->addSubscriber($names);
        try {
            $collection = $client->selectCollection($this->database, 'documents');
            $this->assertTrue($this->preview($recorder, [$store], fn () => $collection->updateOne(['_id' => 'seeded'], ['$set' => ['name' => 'Previewed']]))->isConfirmed());
            $this->assertTrue($this->preview($recorder, [$store], fn () => $collection->findOne(['_id' => 'seeded']))->isConfirmed());
            $this->assertTrue($this->preview($recorder, [$store], static fn () => null)->isConfirmed());
            // What a process runs after answering: nothing is left to end.
            MongoEngine::endLostTransactions();
        } finally {
            $this->raw->getManager()->removeSubscriber($names);
        }
        $this->assertSame(2, count(array_keys($names->names, 'abortTransaction', true)), 'Each Preview that sent a command aborts once.');
        $this->assertNotContains('killSessions', $names->names);
        $this->assertSame('Seeded', $this->documents()->findOne(['_id' => 'seeded'])['name']);
    }
}
