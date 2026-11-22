<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Tests;

use Elastic\Elasticsearch\Client as ElasticsearchClient;
use Google\Cloud\Firestore\FirestoreClient;
use Illuminate\Support\Facades\Route;
use OpenSearch\Client as OpenSearchClient;
use Sendproof\Core\Stores\PreviewWriteBlockedException;
use Sendproof\Laravel\Tests\Support\SearchFakes;

/**
 * The Laravel hooks for Elasticsearch, OpenSearch and Firestore: container-held clients listed in
 * `sendproof.data_stores`, over fake transports (no service needed). Routes swallow a refusal, as a
 * handler may, and the Preview must still answer 409.
 */
final class SearchStoresPreviewTest extends StoresTestCase
{
    protected function stores(): array
    {
        return [];
    }

    protected function configure($app): void
    {
        SearchFakes::$sent = [];
        $app->singleton(ElasticsearchClient::class, fn () => SearchFakes::elasticsearch());
        // Not shared: every resolve builds a new client after boot, and each must be guarded.
        $app->bind(OpenSearchClient::class, fn () => SearchFakes::opensearch());
        $app->singleton(FirestoreClient::class, fn () => SearchFakes::firestore());
        $app['config']->set('sendproof.data_stores', [
            'elasticsearch' => ['clients' => [ElasticsearchClient::class], 'name' => 'search'],
            'opensearch' => ['clients' => [OpenSearchClient::class], 'name' => 'articles'],
            'firestore' => ['clients' => [FirestoreClient::class], 'name' => 'docs'],
        ]);
    }

    protected function storeRoutes(): void
    {
        $swallow = static function (callable $write): \Illuminate\Http\JsonResponse {
            try {
                $write();
            } catch (PreviewWriteBlockedException) {
            }

            return response()->json(['ok' => true]);
        };
        Route::get('/es/articles', fn () => response()->json(['hits' => count($this->app->make(ElasticsearchClient::class)->search(['index' => 'articles', 'body' => ['query' => ['match_all' => new \stdClass()]]])['hits']['hits'])]))->sendproofPreview();
        Route::post('/es/articles', fn () => $swallow(fn () => $this->app->make(ElasticsearchClient::class)->index(['index' => 'articles', 'id' => '1', 'body' => ['title' => 'x']])))->sendproofPreview();
        Route::get('/os/articles', fn () => response()->json(['hits' => count($this->app->make(OpenSearchClient::class)->search(['index' => 'articles', 'body' => ['query' => ['match_all' => new \stdClass()]]])['hits']['hits'])]))->sendproofPreview();
        Route::post('/os/articles', fn () => $swallow(fn () => $this->app->make(OpenSearchClient::class)->updateByQuery(['index' => 'articles', 'body' => ['query' => ['match_all' => new \stdClass()]]])))->sendproofPreview();
        Route::post('/docs/orders', fn () => $swallow(fn () => $this->app->make(FirestoreClient::class)->collection('orders')->document('o-1')->set(['status' => 'new'])))->sendproofPreview();
        Route::delete('/docs/orders', fn () => response()->noContent())->sendproofPreview(false, stores: ['firestore']);
    }

    public function testDiscoveryListsTheThreeStoresInGuardMode(): void
    {
        $this->signIn();
        $capabilities = $this->capabilities();
        $this->assertSame([
            ['system' => 'elasticsearch', 'name' => 'search', 'mode' => 'guard'],
            ['system' => 'opensearch', 'name' => 'articles', 'mode' => 'guard'],
            ['system' => 'firestore', 'name' => 'docs', 'mode' => 'guard'],
        ], $capabilities['dataStores']);
        $this->assertSame('Preview unavailable: this operation writes to Firestore', $capabilities['previewUnavailable'][0]['reason']);
    }

    public function testReadsRunAndAreLoggedWithTheirStore(): void
    {
        $this->signIn();
        $es = $this->preview('/es/articles', method: 'GET')->assertOk()->json();
        $os = $this->preview('/os/articles', method: 'GET')->assertOk()->json();
        $this->assertSame('search', $this->dbEntries($es, 'elasticsearch')[0]['db']['operation']);
        $this->assertSame('search', $this->dbEntries($os, 'opensearch')[0]['db']['operation']);
        $this->assertSame(['POST /articles/_search', 'POST /articles/_search'], SearchFakes::$sent);
    }

    public function testEveryWriteIsRefusedBeforeItIsSentWhateverTheHandlerDoes(): void
    {
        $this->signIn();
        $this->preview('/es/articles')->assertStatus(409)->assertJson(['store' => 'elasticsearch', 'operation' => 'index']);
        $this->preview('/os/articles')->assertStatus(409)->assertJson(['store' => 'opensearch', 'operation' => 'update_by_query']);
        $this->preview('/docs/orders')->assertStatus(409)->assertJson(['store' => 'firestore', 'operation' => 'Commit']);
        $this->assertSame([], SearchFakes::$sent, 'No write may reach a store during a Preview.');
    }

    public function testAMarkedOperationIsNeverRun(): void
    {
        $this->signIn();
        $this->preview('/docs/orders', method: 'DELETE')->assertStatus(409);
    }

    public function testAListedServiceOfTheWrongTypeFailsAtStartup(): void
    {
        $this->app->bind('not-a-search-client', fn () => new \stdClass());
        $this->app['config']->set('sendproof.data_stores', ['opensearch' => ['clients' => ['not-a-search-client']]]);
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('opensearch.clients');
        \Sendproof\Laravel\Stores\DataStores::hook($this->app, $this->app['config']->get('sendproof.data_stores'), $this->app->make(\Sendproof\Laravel\SendproofManager::class)->guard());
    }
}
