<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Tests;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use MongoDB\Client;
use MongoDB\Laravel\Eloquent\Model;
use MongoDB\Laravel\MongoDBServiceProvider;
use Sendproof\Core\Stores\PreviewTransactionControlException;
use Sendproof\Core\Stores\PreviewWriteBlockedException;

/** The Laravel MongoDB hook on a `mongodb/laravel-mongodb` connection, against the compose replica set. */
class MongoPreviewTest extends StoresTestCase
{
    private string $database;
    private Client $reader;

    protected function stores(): array
    {
        return ['mongodb'];
    }

    /** The SQL provider the application uses; null for an application whose only database is MongoDB. */
    protected function sqlProvider(): ?string
    {
        return 'eloquent';
    }

    protected function getPackageProviders($app): array
    {
        return [...parent::getPackageProviders($app), MongoDBServiceProvider::class];
    }

    protected function configure($app): void
    {
        $this->database = 'laravel_' . bin2hex(random_bytes(4));
        $app['config']->set('database.connections.mongodb', ['driver' => 'mongodb', 'dsn' => Services::mongodbUrl() . '&appName=laravel-hooked', 'database' => $this->database]);
        $app['config']->set('sendproof.data_stores', ['mongodb' => ['connection' => 'mongodb', 'name' => 'catalog']]);
        $app['config']->set('sendproof.provider', $this->sqlProvider());
        $this->reader = new Client(Services::mongodbUrl() . '&appName=laravel-reader');
        $this->reader->selectCollection($this->database, 'documents')->insertOne(['_id' => 'seeded', 'name' => 'Seeded', 'profile' => ['city' => 'Leeds'], 'password_hash' => 'hashed:seeded']);
    }

    protected function tearDown(): void
    {
        if (isset($this->reader, $this->database)) {
            $this->reader->dropDatabase($this->database);
        }
        parent::tearDown();
    }

    private function seeded(string $id): mixed
    {
        return $this->reader->selectCollection($this->database, 'documents')->findOne(['_id' => $id]);
    }

    protected function storeRoutes(): void
    {
        Route::post('/documents', function () {
            Document::create(['id' => request('id'), 'name' => request('name'), 'profile' => ['city' => request('city')], 'password_hash' => 'hashed:' . request('password')]);

            return response()->json(['id' => request('id')], 201);
        })->sendproofPreview();
        Route::patch('/documents/{id}', function (string $id) {
            Document::query()->where('_id', $id)->update(['name' => request('name'), 'profile.city' => request('city')]);

            return response()->json(['id' => $id]);
        })->sendproofPreview();
        Route::post('/documents/archive', function () {
            try {
                iterator_to_array(DB::connection('mongodb')->getCollection('documents')->aggregate([['$match' => new \stdClass()], ['$out' => 'archive']]));
            } catch (PreviewWriteBlockedException) {
            }

            return response()->noContent();
        })->sendproofPreview();
        Route::post('/documents/transaction', function () {
            // The handler's own transaction joins the Preview's; neither commit nor abort reaches the server.
            DB::connection('mongodb')->transaction(function (): void {
                Document::create(['id' => 'in-transaction', 'name' => 'Joined']);
            });

            return response()->json(['ok' => true]);
        })->sendproofPreview();
        Route::post('/documents/rollback', function () {
            try {
                DB::connection('mongodb')->transaction(function (): void {
                    Document::create(['id' => 'discarded', 'name' => 'Discarded']);
                    throw new \RuntimeException('Roll back the nested transaction.');
                });
            } catch (\RuntimeException) {
            }

            return response()->json(['ok' => true]);
        })->sendproofPreview();
        Route::post('/documents/commit', function () {
            Document::create(['id' => 'committed', 'name' => 'Committed']);
            try {
                DB::connection('mongodb')->commit();
            } catch (PreviewTransactionControlException) {
            }

            return response()->json(['ok' => true]);
        })->sendproofPreview();
        Route::post('/documents/escape', function () {
            // The raw manager has no hook: the write escapes the Preview transaction.
            $bulk = new \MongoDB\Driver\BulkWrite();
            $bulk->insert(['_id' => 'escaped']);
            DB::connection('mongodb')->getClient()->getManager()->executeBulkWrite($this->database . '.documents', $bulk);

            return response()->json(['ok' => true]);
        })->sendproofPreview();
        Route::delete('/documents/{id}', fn (string $id) => response()->noContent())->sendproofPreview(false, stores: ['mongodb']);
    }

    public function testAPreviewRollsBackEloquentWritesAndReportsNestedRedactedChanges(): void
    {
        $this->signIn();
        $capabilities = $this->capabilities();
        $this->assertSame([['system' => 'mongodb', 'name' => 'catalog', 'mode' => 'preview']], $capabilities['dataStores']);

        $created = $this->preview('/documents', ['id' => 'draft', 'name' => 'Draft', 'city' => 'York', 'password' => 'mongo-secret'])->assertOk()->json();
        $change = $created['changes'][0];
        $this->assertSame(['mongodb', 'insert', 'documents'], [$change['store'], $change['operation'], $change['table']]);
        $this->assertSame('York', $change['after']['profile']['city']);
        $this->assertSame('[REDACTED]', $change['after']['password_hash']);
        $this->assertCount(1, $created['changes'], 'The MongoDB change is listed once, not again as an Eloquent change.');
        $this->assertSame([], $this->dbEntries($created, 'mysql'), 'No MongoDB command is logged as SQL.');
        $this->assertCount(0, array_filter($created['logs'], static fn (array $log): bool => $log['level'] === 'Sql' && str_contains(json_encode($log), 'draft')));
        $this->assertStringNotContainsString('mongo-secret', json_encode($created));
        $this->assertNull($this->seeded('draft'));

        $updated = $this->preview('/documents/seeded', ['name' => 'Renamed', 'city' => 'Hull'], 'PATCH')->assertOk()->json();
        $this->assertSame(['Leeds', 'Hull'], [$updated['changes'][0]['before']['profile']['city'], $updated['changes'][0]['after']['profile']['city']]);
        $this->assertSame('Leeds', $this->seeded('seeded')['profile']['city']);
    }

    public function testOutIsBlockedWithItsReasonAndNothingIsWritten(): void
    {
        $this->signIn();
        $this->preview('/documents/archive')->assertStatus(409)->assertJson(['store' => 'mongodb', 'operation' => 'aggregate'])
            ->assertJsonPath('detail', "Preview unavailable: MongoDB can't run \$out inside a transaction");
        $this->assertNull($this->reader->selectCollection($this->database, 'archive')->findOne([]));
    }

    public function testTheHandlersTransactionJoinsThePreviewAndIsNeverCommitted(): void
    {
        $this->signIn();
        $envelope = $this->preview('/documents/transaction')->assertOk()->json();
        $this->assertSame('in-transaction', $envelope['changes'][0]['key']['_id']);
        $this->assertNull($this->seeded('in-transaction'));
    }

    public function testARollbackInsideTheJoinedTransactionCannotBeHonouredSoThePreviewFails(): void
    {
        $this->signIn();
        $this->preview('/documents/rollback')->assertStatus(500);
        $this->assertNull($this->seeded('discarded'));
    }

    public function testAHandlerCommitIsRefusedAndAnEscapedWriteIsNeverConfirmed(): void
    {
        $this->signIn();
        $this->preview('/documents/commit')->assertStatus(500);
        $this->assertNull($this->seeded('committed'));
        $this->preview('/documents/escape')->assertStatus(500);
        $this->assertNotNull($this->seeded('escaped'), 'The escape could not be undone, which is why the Preview is never confirmed.');
    }

    public function testObservedSendCommitsOnceAndTracesDbEntriesWithoutValues(): void
    {
        $this->signIn();
        $response = $this->json('POST', '/documents', ['id' => 'sent', 'name' => 'Sent', 'city' => 'Ely', 'password' => 'mongo-secret'], ['Prefer' => 'trace'])->assertCreated();
        $this->assertSame('hashed:mongo-secret', $this->seeded('sent')['password_hash']);
        $trace = $this->getJson('/sendproof/_api/traces/' . $response->headers->get('X-Sendproof-Trace'))->assertOk()->json();
        $this->assertSame(['insert'], array_map(static fn (array $entry): string => $entry['db']['operation'], $this->dbEntries($trace, 'mongodb')));
        $this->assertStringNotContainsString('mongo-secret', json_encode($trace));
    }

    public function testAnOperationMarkedUnavailableIsNeverRun(): void
    {
        $this->signIn();
        $this->assertSame('Preview unavailable: this operation writes to MongoDB', collect($this->capabilities()['previewUnavailable'])->firstWhere('path', '/documents/{id}')['reason']);
        $this->preview('/documents/seeded', [], 'DELETE')->assertStatus(409);
    }
}

/** A MongoDB document with a nested profile. */
final class Document extends Model
{
    protected $connection = 'mongodb';
    protected $collection = 'documents';
    protected $guarded = [];
    public $timestamps = false;
}

/** The same checks for an application whose only database is MongoDB: no SQL provider, and Previews still roll back. */
final class MongoWithoutSqlPreviewTest extends MongoPreviewTest
{
    protected function sqlProvider(): ?string
    {
        return null;
    }

    public function testDiscoveryReportsNoSqlDatabaseButStillOffersPreview(): void
    {
        $this->signIn();
        $capabilities = $this->capabilities();
        $this->assertNull($capabilities['database']);
        $this->assertContains(['method' => 'POST', 'path' => '/documents'], $capabilities['previewOperations']);
        $this->assertTrue($capabilities['observedSend']);
    }
}
