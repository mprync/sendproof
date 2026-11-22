<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use Elastic\Elasticsearch\Client as ElasticsearchClient;
use Elastic\Elasticsearch\ClientBuilder as ElasticsearchBuilder;
use GuzzleHttp\Ring\Future\CompletedFutureArray;
use OpenSearch\Client as OpenSearchClient;
use OpenSearch\ClientBuilder as OpenSearchBuilder;
use OpenSearch\EndpointFactory;
use OpenSearch\HttpTransport;
use OpenSearch\SerializerInterface;
use OpenSearch\Serializers\SmartSerializer;
use OpenSearch\TransportFactory;
use PHPUnit\Framework\AssertionFailedError;
use PHPUnit\Framework\TestCase;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Stores\Guard;
use Sendproof\Core\Stores\GuardOnlyStore;
use Sendproof\Core\Stores\PreviewWriteBlockedException;
use Sendproof\Core\Stores\Search\ElasticsearchGuard;
use Sendproof\Core\Stores\Search\GuardedHttpClient;
use Sendproof\Core\Stores\Search\OpenSearchGuard;
use Sendproof\Core\Tests\Support\RecordingHttpClient;
use Sendproof\Core\Tests\Support\RunsPreviews;

/**
 * The Elasticsearch and OpenSearch write guards (spec/data-stores.md, `guard` mode) on the real
 * client libraries, over a fake transport that records what reaches the network. Each client is
 * hooked after it is built. The same checks run on every way to send: Elasticsearch's PSR-18 client
 * (sync and async), OpenSearch's PSR-18 transport, and OpenSearch's legacy RingPHP handler.
 */
final class SearchStoreTest extends TestCase
{
    use RunsPreviews;

    /**
     * @return array<string,array{0:string,1:string}> name => [engine, transport kind]
     */
    public static function engines(): array
    {
        return [
            'elasticsearch psr-18' => ['elasticsearch', 'psr18'],
            'opensearch psr-18' => ['opensearch', 'psr18'],
            'opensearch legacy handler' => ['opensearch', 'legacy'],
        ];
    }

    /**
     * A hooked client for `$engine`, with the fake transport that records what it sent.
     *
     * @return array{0:Recorder,1:object,2:RecordingHttpClient,3:GuardOnlyStore}
     */
    private function hooked(string $engine, string $kind, bool $hook = true, ?array $reads = null, string $host = 'http://search.test:9200'): array
    {
        $recorder = new Recorder();
        $guard = new Guard(static fn () => $recorder);
        $fake = new RecordingHttpClient();
        $client = $this->build($engine, $kind, $fake, $host);
        if ($hook) {
            $engine === 'elasticsearch' ? ElasticsearchGuard::install($client, $guard, $reads) : OpenSearchGuard::install($client, $guard, $reads);
        }

        return [$recorder, $client, $fake, new GuardOnlyStore($engine, 'articles')];
    }

    private function build(string $engine, string $kind, RecordingHttpClient $fake, string $host): object
    {
        if ($engine === 'elasticsearch') {
            return ElasticsearchBuilder::create()->setHosts([$host])->setHttpClient($fake)->build();
        }
        if ($kind === 'psr18') {
            $serializer = new SmartSerializer();

            return new OpenSearchClient((new TransportFactory())->setHttpClient($fake)->create(), new EndpointFactory($serializer), []);
        }
        // The legacy transport sends through a RingPHP handler, which the fake answers from the request array.
        $handler = static function (array $request) use ($fake): CompletedFutureArray {
            $fake->sent[] = ['method' => $request['http_method'], 'url' => 'http://search.test:9200' . $request['uri'], 'body' => (string) ($request['body'] ?? '')];

            return new CompletedFutureArray([
                'status' => 200, 'reason' => 'OK', 'effective_url' => 'http://search.test:9200' . $request['uri'],
                'headers' => ['Content-Type' => ['application/json']],
                'body' => fopen('data://text/plain,' . rawurlencode('{"hits":{"hits":[{"_id":"1"}]},"result":"created","updated":2}'), 'r'),
                'transfer_stats' => ['total_time' => 0.001],
            ]);
        };

        return OpenSearchBuilder::create()->setHosts([$host])->setHandler($handler)->build();
    }

    /** The request `index()` with an id sends: Elasticsearch's client uses PUT, OpenSearch's POST. */
    private static function indexRequest(string $engine): string
    {
        return ($engine === 'elasticsearch' ? 'PUT' : 'POST') . ' /articles/_doc/a';
    }

    /** The search read used by the checks. */
    private function search(object $client): void
    {
        $client->search(['index' => 'articles', 'body' => ['query' => ['ids' => ['values' => ['seeded']]], 'size' => 1]]);
    }

    /** @return array<string,\Closure> the writes every engine must refuse, by the operation name the 409 reports */
    private function writes(object $client): array
    {
        return [
            'index' => fn () => $client->index(['index' => 'articles', 'id' => 'a', 'body' => ['title' => 'x']]),
            'update' => fn () => $client->update(['index' => 'articles', 'id' => 'a', 'body' => ['script' => ['source' => 'ctx._source.views += 1'], 'upsert' => ['views' => 1]]]),
            'update_by_query' => fn () => $client->updateByQuery(['index' => 'articles', 'body' => ['query' => ['match_all' => new \stdClass()]]]),
            'delete_by_query' => fn () => $client->deleteByQuery(['index' => 'articles', 'body' => ['query' => ['match_all' => new \stdClass()]]]),
            'bulk' => fn () => $client->bulk(['body' => [['index' => ['_index' => 'articles', '_id' => 'a']], ['title' => 'x']]]),
            'delete' => fn () => $client->delete(['index' => 'articles', 'id' => 'a']),
            'indices.create' => fn () => $client->indices()->create(['index' => 'fresh']),
            'indices.delete' => fn () => $client->indices()->delete(['index' => 'articles']),
        ];
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('engines')]
    public function testReadsRunAndEveryWriteIsRefusedBeforeItIsSent(string $engine, string $kind): void
    {
        [$recorder, $client, $fake, $store] = $this->hooked($engine, $kind);
        $read = $this->preview($recorder, [$store], fn () => $this->search($client));
        $this->assertTrue($read->isConfirmed(), 'A POST _search is a read');
        $this->assertSame(['POST /articles/_search'], $fake->requests());
        $entry = array_values(array_filter($read->envelope['logs'], static fn (array $log): bool => $log['level'] === 'Db'))[0]['db'];
        $this->assertSame($engine, $entry['system']);
        $this->assertSame('search', $entry['operation']);
        $this->assertSame('articles', $entry['target']);
        $this->assertSame(1, $entry['rowsAffected']);
        $this->assertStringNotContainsString('seeded', $entry['statement'], 'Values are replaced by ?');
        $this->assertSame('{"query":{"ids":{"values":["?"]}},"size":"?"}', $entry['statement']);

        foreach ($this->writes($client) as $operation => $write) {
            $result = $this->preview($recorder, [$store], function () use ($write): void {
                try {
                    $write();
                } catch (PreviewWriteBlockedException) {
                    // The handler swallows the refusal; the Preview must still answer 409.
                }
            });
            $this->assertSame(409, $result->status, $operation);
            $this->assertSame($operation, $result->problem()['operation']);
            $this->assertSame($engine, $result->problem()['store']);
            $this->assertSame('Preview unavailable: this operation writes to ' . Guard::storeName($engine), $result->problem()['detail']);
        }
        $this->assertSame(['POST /articles/_search'], $fake->requests(), 'No write may reach the network during a Preview.');
    }

    /**
     * The writes outside the typed document calls: reindex, stored scripts, aliases, templates,
     * mappings, settings, pipelines, a raw request and an endpoint the table has never heard of.
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('engines')]
    public function testScriptsReindexAliasesTemplatesAndRawRequestsAreRefusedBeforeTheyAreSent(string $engine, string $kind): void
    {
        [$recorder, $client, $fake, $store] = $this->hooked($engine, $kind);
        $raw = $engine === 'elasticsearch'
            ? static fn (string $method, string $path) => $client->sendRequest(new \GuzzleHttp\Psr7\Request($method, $path, ['Content-Type' => 'application/json'], '{}'))
            : static fn (string $method, string $path) => $client->request($method, $path, ['body' => '{}']);
        $writes = [
            'reindex' => fn () => $client->reindex(['body' => ['source' => ['index' => 'articles'], 'dest' => ['index' => 'copy']]]),
            'put_script' => fn () => $client->putScript(['id' => 's', 'body' => ['script' => ['lang' => 'painless', 'source' => 'ctx._source.x = 1']]]),
            'delete_script' => fn () => $client->deleteScript(['id' => 's']),
            'update_aliases' => fn () => $client->indices()->updateAliases(['body' => ['actions' => [['add' => ['index' => 'articles', 'alias' => 'live']]]]]),
            'put_alias' => fn () => $client->indices()->putAlias(['index' => 'articles', 'name' => 'live']),
            'put_index_template' => fn () => $client->indices()->putIndexTemplate(['name' => 't', 'body' => ['index_patterns' => ['a*']]]),
            'put_mapping' => fn () => $client->indices()->putMapping(['index' => 'articles', 'body' => ['properties' => ['x' => ['type' => 'keyword']]]]),
            'put_settings' => fn () => $client->indices()->putSettings(['index' => 'articles', 'body' => ['index' => ['number_of_replicas' => 0]]]),
            'put_pipeline' => fn () => $client->ingest()->putPipeline(['id' => 'p', 'body' => ['processors' => []]]),
            'close' => fn () => $client->indices()->close(['index' => 'articles']),
            'raw document' => fn () => $raw('PUT', '/articles/_doc/raw'),
            'raw unknown endpoint' => fn () => $raw('POST', '/_brand_new/_thing'),
            'raw patch' => fn () => $raw('PATCH', '/articles'),
        ];
        foreach ($writes as $name => $write) {
            $refused = false;
            $result = $this->preview($recorder, [$store], function () use ($write, &$refused): void {
                try {
                    $write();
                } catch (PreviewWriteBlockedException) {
                    $refused = true;
                }
            });
            $this->assertTrue($refused, $name . ' was not refused');
            $this->assertSame(409, $result->status, $name);
            $this->assertSame($engine, $result->problem()['store'], $name);
        }
        $this->assertSame([], $fake->requests(), 'No write may reach the network during a Preview.');
        // A raw read still runs.
        $this->assertTrue($this->preview($recorder, [$store], fn () => $raw('GET', '/articles/_doc/raw'))->isConfirmed());
        $this->assertSame(['GET /articles/_doc/raw'], $fake->requests());
    }

    /**
     * A refusal is not a network failure: the client's node pool and retry loop must not see it, or
     * one refused write would mark a node dead (or retry the write on the next node) and hurt every
     * other request on the process, Preview or not. Two nodes, no retries counted, both still alive.
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('engines')]
    public function testARefusedWriteNeverMarksANodeDeadOrRetries(string $engine, string $kind): void
    {
        if ($engine === 'opensearch' && $kind === 'psr18') {
            // The PSR-18 transport has no node pool or retries of its own: it sends to one base URI.
            $this->expectNotToPerformAssertions();

            return;
        }
        $recorder = new Recorder();
        $guard = new Guard(static fn () => $recorder);
        $fake = new RecordingHttpClient();
        $hosts = ['http://node-a.test:9200', 'http://node-b.test:9200'];
        if ($engine === 'elasticsearch') {
            $client = ElasticsearchBuilder::create()->setHosts($hosts)->setHttpClient($fake)->setRetries(3)->build();
            ElasticsearchGuard::install($client, $guard);
            $pool = $client->getTransport()->getNodePool();
            $alive = static fn (): array => array_map(static fn (\Elastic\Transport\NodePool\Node $node): bool => $node->isAlive(), \Closure::bind(fn (): array => $this->nodes, $pool, $pool::class)());
        } else {
            $handler = static function (array $request) use ($fake): CompletedFutureArray {
                $fake->sent[] = ['method' => $request['http_method'], 'url' => 'http://search.test:9200' . $request['uri'], 'body' => (string) ($request['body'] ?? '')];

                return new CompletedFutureArray(['status' => 200, 'reason' => 'OK', 'effective_url' => 'http://search.test:9200' . $request['uri'], 'headers' => ['Content-Type' => ['application/json']], 'body' => fopen('data://text/plain,{}', 'r'), 'transfer_stats' => ['total_time' => 0.001]]);
            };
            $client = OpenSearchBuilder::create()->setHosts($hosts)->setHandler($handler)->setRetries(3)->build();
            OpenSearchGuard::install($client, $guard);
            // @phpstan-ignore property.deprecated
            $pool = $client->transport->connectionPool;
            $alive = static fn (): array => array_map(static fn (\OpenSearch\Connections\Connection $connection): bool => $connection->getPingFailures() === 0, \Closure::bind(fn (): array => $this->connections, $pool, \OpenSearch\ConnectionPool\AbstractConnectionPool::class)());
        }
        $this->assertSame([true, true], $alive());
        $store = new GuardOnlyStore($engine);
        $result = $this->preview($recorder, [$store], function () use ($client): void {
            try {
                $client->index(['index' => 'articles', 'id' => 'a', 'body' => ['t' => 1]]);
            } catch (PreviewWriteBlockedException) {
            }
        });
        $this->assertSame(409, $result->status);
        $this->assertSame([true, true], $alive(), 'The refusal marked a node dead');
        $this->assertSame([], $fake->requests(), 'The refused write was retried or sent');
        // The next read, and the next Send, run on a healthy pool.
        $this->assertTrue($this->preview($recorder, [$store], fn () => $this->search($client))->isConfirmed());
        $recorder->begin(false);
        $client->index(['index' => 'articles', 'id' => 'a', 'body' => ['t' => 1]]);
        $recorder->finish();
        $this->assertSame(['POST /articles/_search', self::indexRequest($engine)], $fake->requests());
        $this->assertSame([true, true], $alive());
    }

    /**
     * spec/data-stores.md, "Writes the binding can't attribute to a request": work the handler starts
     * that writes after the response (PHP's after-response callbacks: `defer()`, `terminating()`,
     * `kernel.terminate`, shutdown functions, `fastcgi_finish_request()`) still carries the ended
     * Preview's scope and is refused before it is sent.
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('engines')]
    public function testWorkTheHandlerStartedThatWritesAfterTheResponseIsRefused(string $engine, string $kind): void
    {
        [$recorder, $client, $fake, $store] = $this->hooked($engine, $kind);
        $afterResponse = [];
        $result = $this->preview($recorder, [$store], function () use ($client, &$afterResponse): void {
            $afterResponse[] = static fn () => $client->index(['index' => 'articles', 'id' => 'late', 'body' => ['t' => 1]]);
        });
        $this->assertTrue($result->isConfirmed(), 'The handler wrote nothing before it returned');
        foreach ($afterResponse as $task) {
            try {
                $task();
                $this->fail('The after-response write was sent.');
            } catch (PreviewWriteBlockedException $refusal) {
                $this->assertSame('index', $refusal->operation);
            }
        }
        $this->assertSame($engine, $recorder->blocked()['store'], 'The ended Preview is still a Preview');
        $this->assertSame([], $fake->requests());
    }

    /** Elasticsearch's bulk helper sends each chunk from the caller's call, so the refusal reaches the caller at once. */
    public function testTheElasticsearchBulkHelperIsRefusedOnTheCallersCall(): void
    {
        if (!class_exists(\Elastic\Elasticsearch\Helper\Bulk::class)) {
            $this->markTestSkipped('This elasticsearch/elasticsearch release has no bulk helper.');
        }
        [$recorder, $client, $fake, $store] = $this->hooked('elasticsearch', 'psr18');
        $refused = 0;
        $result = $this->preview($recorder, [$store], function () use ($client, &$refused): void {
            try {
                \Elastic\Elasticsearch\Helper\Bulk::bulk($client, 'articles', new \ArrayIterator([[['index' => ['_id' => 'a']], ['t' => 1]]]));
            } catch (PreviewWriteBlockedException) {
                $refused++;
            }
        });
        $this->assertSame(1, $refused);
        $this->assertSame(409, $result->status);
        $this->assertSame('bulk', $result->problem()['operation']);
        $this->assertSame([], $fake->requests());
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('engines')]
    public function testWithTheHookRemovedTheWritesReachTheNetworkAndTheGuardChecksFail(string $engine, string $kind): void
    {
        [$recorder, $client, $fake, $store] = $this->hooked($engine, $kind, hook: false);
        $result = $this->preview($recorder, [$store], fn () => $client->index(['index' => 'articles', 'id' => 'a', 'body' => ['title' => 'x']]));
        // This is what the test above asserts against, and it fails here: the write went out and the Preview wasn't refused.
        $this->assertSame([self::indexRequest($engine)], $fake->requests());
        $this->assertNotSame(409, $result->status);
        $this->expectException(AssertionFailedError::class);
        $this->assertSame(['POST /articles/_search'], $fake->requests(), 'No write may reach the network during a Preview.');
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('engines')]
    public function testOutsideAPreviewEveryRequestIsSentAndObservedSendLogsEachOnce(string $engine, string $kind): void
    {
        [$recorder, $client, $fake] = $this->hooked($engine, $kind);
        $recorder->begin(false);
        $client->index(['index' => 'articles', 'id' => 'a', 'body' => ['title' => 'Untitled', 'views' => 1], 'refresh' => 'true']);
        $client->update(['index' => 'articles', 'id' => 'a', 'body' => ['script' => ['source' => 'ctx._source.views += params.step', 'params' => ['step' => 1]]]]);
        $this->assertSame([self::indexRequest($engine), 'POST /articles/_update/a'], $fake->requests());
        $db = array_values(array_filter($recorder->finish()['logs'], static fn (array $log): bool => $log['level'] === 'Db'));
        $this->assertSame(['index', 'update'], array_map(static fn (array $log): string => $log['db']['operation'], $db), 'Each request is logged once');
        $this->assertSame('{"script":{"source":"?","params":{"step":"?"}}}', $db[1]['db']['statement']);
        $this->assertStringNotContainsString('Untitled', json_encode($db));
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('engines')]
    public function testHookingAClientTwiceLogsEachRequestOnce(string $engine, string $kind): void
    {
        [$recorder, $client, $fake] = $this->hooked($engine, $kind);
        $guard = new Guard(static fn () => $recorder);
        $engine === 'elasticsearch' ? ElasticsearchGuard::install($client, $guard) : OpenSearchGuard::install($client, $guard);
        $recorder->begin(false);
        $this->search($client);
        $this->assertCount(1, array_filter($recorder->finish()['logs'], static fn (array $log): bool => $log['level'] === 'Db'));
        $this->assertCount(1, $fake->sent);
    }

    public function testOpenSearchSqlIsAReadOnlyForASingleSelect(): void
    {
        foreach (['psr18', 'legacy'] as $kind) {
            [$recorder, $client, $fake, $store] = $this->hooked('opensearch', $kind);
            $read = $this->preview($recorder, [$store], fn () => $client->sql()->query(['body' => ['query' => 'SELECT title FROM articles']]));
            $this->assertTrue($read->isConfirmed(), $kind);
            $write = $this->preview($recorder, [$store], function () use ($client): void {
                try {
                    $client->sql()->query(['body' => ['query' => 'DELETE FROM articles WHERE views = 0']]);
                } catch (PreviewWriteBlockedException) {
                }
            });
            $this->assertSame(409, $write->status, $kind);
            $this->assertSame('sql.query', $write->problem()['operation']);
            $this->assertCount(1, $fake->sent, 'Only the SELECT was sent');
        }
    }

    public function testElasticsearchRawSqlAndAsyncRequestsAreGuarded(): void
    {
        [$recorder, $client, $fake, $store] = $this->hooked('elasticsearch', 'psr18');
        $sql = static fn (string $query) => static fn () => $client->sendRequest(new \GuzzleHttp\Psr7\Request('POST', '/_sql?format=json', ['Content-Type' => 'application/json'], json_encode(['query' => $query])));
        $this->assertTrue($this->preview($recorder, [$store], $sql('SELECT 1'))->isConfirmed());
        $result = $this->preview($recorder, [$store], function () use ($sql): void {
            try {
                $sql('DELETE FROM t')();
            } catch (PreviewWriteBlockedException) {
            }
        });
        $this->assertSame(409, $result->status);
        $this->assertCount(1, $fake->sent);

        // In async mode a refused write throws from the call itself, with no promise to wait for.
        $client->setAsync(true);
        $result = $this->preview($recorder, [$store], function () use ($client): void {
            try {
                $client->index(['index' => 'articles', 'id' => 'a', 'body' => ['t' => 1]]);
            } catch (PreviewWriteBlockedException) {
            }
        });
        $this->assertSame(409, $result->status);
        $this->assertSame(['index'], [$result->problem()['operation']]);
        $this->assertCount(1, $fake->sent, 'The async write was never sent');
        // An async read still runs and is logged.
        $read = $this->preview($recorder, [$store], function () use ($client): void {
            $client->search(['index' => 'articles', 'body' => ['query' => ['match_all' => new \stdClass()]]])->wait();
        });
        $this->assertTrue($read->isConfirmed());
        $this->assertCount(2, $fake->sent);
    }

    public function testAnExplicitAsyncClientIsGuardedToo(): void
    {
        $recorder = new Recorder();
        $sync = new RecordingHttpClient();
        $async = new RecordingHttpClient();
        $client = ElasticsearchBuilder::create()->setHosts(['http://search.test:9200'])->setHttpClient($sync)->setAsyncHttpClient($async)->build();
        ElasticsearchGuard::install($client, new Guard(static fn () => $recorder));
        $client->setAsync(true);
        $result = $this->preview($recorder, [new GuardOnlyStore('elasticsearch')], function () use ($client): void {
            try {
                $client->delete(['index' => 'articles', 'id' => 'a']);
            } catch (PreviewWriteBlockedException) {
            }
        });
        $this->assertSame(409, $result->status);
        $this->assertSame([], $async->sent);
        $this->assertSame([], $sync->sent);
    }

    public function testAConfiguredPathPrefixIsIgnoredWhenClassifying(): void
    {
        [$recorder, $client, $fake, $store] = $this->hooked('elasticsearch', 'psr18', host: 'http://search.test:9200/proxy/es');
        $this->assertTrue($this->preview($recorder, [$store], fn () => $this->search($client))->isConfirmed(), 'The search under the prefix is still a read');
        $this->assertSame(['POST /proxy/es/articles/_search'], $fake->requests());
        $result = $this->preview($recorder, [$store], function () use ($client): void {
            try {
                $client->index(['index' => 'articles', 'id' => 'a', 'body' => ['t' => 1]]);
            } catch (PreviewWriteBlockedException) {
            }
        });
        $this->assertSame(409, $result->status);
        $this->assertSame('index', $result->problem()['operation']);
    }

    public function testBuildingTheClientWithTheGuardedHttpClientCoversItFromTheStart(): void
    {
        $recorder = new Recorder();
        $guard = new Guard(static fn () => $recorder);
        $fake = new RecordingHttpClient();
        $http = ElasticsearchGuard::httpClient($fake, $guard);
        $client = ElasticsearchBuilder::create()->setHosts(['http://search.test:9200'])->setHttpClient($http)->setAsyncHttpClient($http)->build();
        ElasticsearchGuard::install($client, $guard);
        $result = $this->preview($recorder, [new GuardOnlyStore('elasticsearch')], function () use ($client): void {
            try {
                $client->bulk(['body' => [['index' => ['_index' => 'a']], ['t' => 1]]]);
            } catch (PreviewWriteBlockedException) {
            }
        });
        $this->assertSame(409, $result->status);
        $this->assertSame([], $fake->sent);

        // The same for OpenSearch's PSR-18 transport and its legacy handler.
        $os = new OpenSearchClient((new TransportFactory())->setHttpClient(OpenSearchGuard::httpClient($fake, $guard))->create(), new EndpointFactory(new SmartSerializer()), []);
        $legacy = OpenSearchBuilder::create()->setHosts(['http://search.test:9200'])
            ->setHandler(OpenSearchGuard::handler(static fn () => throw new \LogicException('The handler must not be reached.'), $guard))->build();
        foreach ([$os, $legacy] as $client) {
            $result = $this->preview($recorder, [new GuardOnlyStore('opensearch')], function () use ($client): void {
                try {
                    $client->index(['index' => 'a', 'body' => ['t' => 1]]);
                } catch (PreviewWriteBlockedException) {
                }
            });
            $this->assertSame(409, $result->status);
        }
        $this->assertSame([], $fake->sent);
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('engines')]
    public function testHostDeclaredReadsAreExactOperationNames(string $engine, string $kind): void
    {
        [$recorder, $client, $fake, $store] = $this->hooked($engine, $kind, reads: Guard::readSet(['update_by_query']));
        $this->assertTrue($this->preview($recorder, [$store], fn () => $client->updateByQuery(['index' => 'articles', 'body' => ['query' => ['match_all' => new \stdClass()]]]))->isConfirmed());
        $result = $this->preview($recorder, [$store], function () use ($client): void {
            try {
                $client->deleteByQuery(['index' => 'articles', 'body' => ['query' => ['match_all' => new \stdClass()]]]);
            } catch (PreviewWriteBlockedException) {
            }
        });
        $this->assertSame(409, $result->status);
        $this->assertCount(1, $fake->sent);
    }

    public function testACredentialInTheClientConfigurationNeverReachesACapture(): void
    {
        $recorder = new Recorder();
        $fake = new RecordingHttpClient();
        $client = ElasticsearchBuilder::create()->setHosts(['http://search.test:9200'])->setHttpClient($fake)->setApiKey('benchApiKey-php-secret')->build();
        ElasticsearchGuard::install($client, new Guard(static fn () => $recorder));
        $result = $this->preview($recorder, [new GuardOnlyStore('elasticsearch')], fn () => $this->search($client));
        $text = json_encode($result->envelope);
        foreach (['benchApiKey-php-secret', 'Authorization', 'search.test'] as $secret) {
            $this->assertStringNotContainsString($secret, $text);
        }
    }

    public function testAnOpenSearchClientWithATransportOfItsOwnIsRefusedNotLeftUnguarded(): void
    {
        $custom = new class implements \OpenSearch\TransportInterface {
            public function sendRequest(string $method, string $uri, array $params = [], mixed $body = null, array $headers = []): iterable|string|null
            {
                return [];
            }
        };
        $client = new OpenSearchClient($custom, new EndpointFactory(new SmartSerializer()), []);
        $this->expectException(\LogicException::class);
        $this->expectExceptionMessage("can't guard an OpenSearch client");
        OpenSearchGuard::install($client, new Guard(static fn () => new Recorder()));
    }

    public function testTheGuardedClientsAreTheOnesInstalledInPlace(): void
    {
        [, $elastic] = $this->hooked('elasticsearch', 'psr18');
        $this->assertInstanceOf(ElasticsearchClient::class, $elastic);
        $this->assertInstanceOf(GuardedHttpClient::class, $elastic->getTransport()->getClient());
        [, $psr] = $this->hooked('opensearch', 'psr18');
        $http = \Closure::bind(fn () => $this->httpTransport, $psr, OpenSearchClient::class)();
        $this->assertInstanceOf(HttpTransport::class, $http);
        $this->assertInstanceOf(GuardedHttpClient::class, \Closure::bind(fn () => $this->client, $http, HttpTransport::class)());
    }
}
