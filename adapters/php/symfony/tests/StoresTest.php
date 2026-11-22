<?php

declare(strict_types=1);

namespace Sendproof\Symfony\Tests;

use Aws\DynamoDb\DynamoDbClient;
use Doctrine\Persistence\ManagerRegistry;
use MongoDB\Client as MongoClient;
use PHPUnit\Framework\TestCase;
use Predis\Client as PredisClient;
use Symfony\Component\Config\Definition\Processor;
use Symfony\Component\DependencyInjection\ContainerBuilder;
use Symfony\Component\DependencyInjection\Definition;
use Symfony\Component\DependencyInjection\ServiceLocator;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Loader\ClosureLoader;
use Symfony\Component\Routing\Route;
use Symfony\Component\Routing\RouteCollection;
use Symfony\Component\Routing\Router;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Stores\MongoDb\GuardedClient;
use Sendproof\Core\Stores\PreviewTransactionControlException;
use Sendproof\Core\Stores\PreviewWriteBlockedException;
use Sendproof\Symfony\Attribute\AllowPreview;
use Sendproof\Symfony\Controller\WorkbenchController;
use Sendproof\Symfony\DependencyInjection\Configuration;
use Sendproof\Symfony\DependencyInjection\DataStorePass;
use Sendproof\Symfony\Doctrine\DoctrinePreviewProvider;
use Sendproof\Symfony\Http\RouteCatalog;
use Sendproof\Symfony\Stores\MongoLostSessions;
use Sendproof\Symfony\Identity\DefaultIdentityResolver;
use Sendproof\Symfony\SendproofManager;
use Sendproof\Symfony\Stores\HookedStores;

/** Data stores in the Symfony bundle: client hooks, discovery, `preview: false`, and the DBAL transaction-control rule. */
final class StoresTest extends DoctrineTestCase
{
    /** @param array<string,mixed> $config */
    private function container(array $config, string $environment = 'dev'): ContainerBuilder
    {
        $settings = (new Processor())->processConfiguration(new Configuration(), [$config]);
        $container = new ContainerBuilder();
        $container->setParameter('kernel.environment', $environment);
        $container->setParameter('sendproof.settings', $settings);
        $container->register(Recorder::class, Recorder::class)->setPublic(true);
        $container->register('sendproof.manager', \stdClass::class)->setArguments([null, null, null, null, null, null, null, null, null])->setPublic(true);
        $container->register('app.redis', PredisClient::class)->setArguments([['host' => '127.0.0.1', 'port' => 6379]])->setPublic(true);
        $container->register('app.dynamo', DynamoDbClient::class)->setArguments([['region' => 'us-east-1', 'version' => 'latest', 'credentials' => ['key' => 'k', 'secret' => 's']]])->setPublic(true);
        $container->register('app.mongo', MongoClient::class)->setArguments(['mongodb://127.0.0.1:27017/?directConnection=true&appName=symfony-stores'])->setPublic(true);
        (new DataStorePass())->process($container);
        if ($container->hasDefinition(HookedStores::class)) {
            $container->getDefinition(HookedStores::class)->setPublic(true);
        }

        return $container;
    }

    public function testDataStoresAreEmptyByDefault(): void
    {
        $config = (new Processor())->processConfiguration(new Configuration(), [[]]);
        $this->assertSame([], $config['data_stores']);
        $config = (new Processor())->processConfiguration(new Configuration(), [['data_stores' => ['mongodb' => ['clients' => ['app.mongo']]]]]);
        $this->assertSame(['clients' => ['app.mongo'], 'name' => null, 'treat_as_read' => null, 'preview_timeout_ms' => 50000], $config['data_stores']['mongodb']);
    }

    /**
     * A session whose abort was lost is killed on `kernel.terminate`, after every request, as a
     * long-lived worker (RoadRunner, FrankenPHP, a kept kernel) runs no shutdown function between
     * requests. Its abort was lost long ago and its engine's server can't be reached, so the one try
     * fails and the warning goes to the application's logger.
     */
    public function testALostMongoSessionIsEndedOnKernelTerminateAndItsWarningGoesToTheLogger(): void
    {
        $container = $this->container(['enabled' => true, 'data_stores' => ['mongodb' => ['clients' => ['app.mongo']]]]);
        $container->register('test.log', \Monolog\Handler\TestHandler::class)->setPublic(true);
        $container->register('logger', \Monolog\Logger::class)->setArguments(['test', [new \Symfony\Component\DependencyInjection\Reference('test.log')]])->setPublic(true);
        $listener = MongoLostSessions::class;
        $this->assertTrue($container->hasDefinition($listener), 'The listener is registered when a MongoDB client is listed.');
        $this->assertSame([['event' => 'kernel.terminate', 'method' => 'onTerminate']], $container->getDefinition($listener)->getTag('kernel.event_listener'));
        $container->getDefinition($listener)->setPublic(true);
        $container->compile();

        $engine = \Sendproof\Core\Stores\MongoDb\MongoEngine::class;
        $recorder = new Recorder();
        $nowhere = new $engine(new \MongoDB\Driver\Manager('mongodb://127.0.0.1:1/?directConnection=true'), new \Sendproof\Core\Stores\Guard(static fn () => $recorder));
        $url = getenv('BENCH_MONGODB_SERVER_URL') ?: 'mongodb://127.0.0.1:57017/?directConnection=true';
        try {
            $session = (new MongoClient($url . '&appName=symfony-lost&serverSelectionTimeoutMS=1500'))->getManager()->startSession();
        } catch (\MongoDB\Driver\Exception\ConnectionException) {
            $this->markTestSkipped('MongoDB is not answering; start it with: docker compose -f tests/conformance/compose.yml up -d --wait mongodb');
        }
        $lost = new \ReflectionProperty($engine, 'lost');
        $lost->setValue(null, [...$lost->getValue(), [$nowhere, $session, hrtime(true) - 20_000_000_000]]);
        $id = $engine::lsidHex($session->getLogicalSessionId());
        try {
            $container->get($listener)->onTerminate();
        } finally {
            $engine::useLogger(null);
        }

        $this->assertSame([], $lost->getValue(), 'The lost session was handled after the request.');
        $this->assertTrue($container->get('test.log')->hasWarningThatContains("couldn't end a MongoDB Preview transaction (session {$id})"), 'The warning reached the logger.');

        $without = $this->container(['enabled' => true, 'data_stores' => ['redis' => ['clients' => ['app.redis']]]]);
        $this->assertFalse($without->hasDefinition($listener), 'No MongoDB client, no listener.');
    }

    public function testListedClientsAreHookedWhenTheContainerBuildsThemAndWritesAreRefused(): void
    {
        $container = $this->container(['enabled' => true, 'data_stores' => [
            'redis' => ['clients' => ['app.redis'], 'name' => 'cache'],
            'dynamodb' => ['clients' => ['app.dynamo'], 'name' => 'orders'],
            'mongodb' => ['clients' => ['app.mongo'], 'name' => 'catalog'],
        ]]);
        $container->compile();
        $recorder = $container->get(Recorder::class);

        $this->assertInstanceOf(GuardedClient::class, $container->get('app.mongo'), 'The MongoDB client is decorated under its own id.');
        $recorder->begin(true);
        foreach ([
            'Redis' => fn () => $container->get('app.redis')->incr('k'),
            'DynamoDB' => fn () => $container->get('app.dynamo')->putItem(['TableName' => 't', 'Item' => ['id' => ['S' => '1']]]),
            'MongoDB' => fn () => $container->get('app.mongo')->selectCollection('db', 'c')->insertOne(['_id' => 1]),
        ] as $store => $write) {
            try {
                $write();
                $this->fail("{$store} write was not refused.");
            } catch (PreviewWriteBlockedException $refusal) {
                $this->assertStringContainsString($store, $refusal->getMessage());
            }
        }
        // The guard records the first refusal on the request's recorder, which the Preview runner turns into a 409.
        $this->assertSame('redis', $recorder->blocked()['store']);

        $this->assertEqualsCanonicalizing(['mongodb', 'redis', 'dynamodb'], array_map(static fn ($store): string => $store->system(), $container->get(HookedStores::class)->all()));
    }

    /** @var list<string> what the fake transports of the search and Firestore clients received */
    public static array $sent = [];

    /** A fake PSR-18 client for the Elasticsearch and OpenSearch clients. */
    private static function http(): \Psr\Http\Client\ClientInterface
    {
        return new class implements \Psr\Http\Client\ClientInterface {
            public function sendRequest(\Psr\Http\Message\RequestInterface $request): \Psr\Http\Message\ResponseInterface
            {
                StoresTest::$sent[] = $request->getMethod() . ' ' . $request->getUri()->getPath();

                return new \GuzzleHttp\Psr7\Response(200, ['X-Elastic-Product' => 'Elasticsearch', 'Content-Type' => 'application/json'], '{"hits":{"hits":[]},"result":"created"}');
            }
        };
    }

    public static function elasticsearchClient(): \Elastic\Elasticsearch\Client
    {
        return \Elastic\Elasticsearch\ClientBuilder::create()->setHosts(['http://es.test:9200'])->setHttpClient(self::http())->build();
    }

    /** OpenSearch with the legacy `ClientBuilder` (RingPHP handler), the transport the Symfony fixture uses. */
    public static function opensearchClient(): \OpenSearch\Client
    {
        $handler = static function (array $request): \GuzzleHttp\Ring\Future\CompletedFutureArray {
            StoresTest::$sent[] = $request['http_method'] . ' ' . explode('?', $request['uri'])[0];

            return new \GuzzleHttp\Ring\Future\CompletedFutureArray([
                'status' => 200, 'reason' => 'OK', 'effective_url' => 'http://os.test:9200' . $request['uri'], 'headers' => ['Content-Type' => ['application/json']],
                'body' => fopen('data://text/plain,' . rawurlencode('{"hits":{"hits":[]}}'), 'r'), 'transfer_stats' => ['total_time' => 0.001],
            ]);
        };

        return \OpenSearch\ClientBuilder::create()->setHosts(['http://os.test:9200'])->setHandler($handler)->build();
    }

    public static function firestoreClient(): \Google\Cloud\Firestore\FirestoreClient
    {
        $transport = new class implements \Google\ApiCore\Transport\TransportInterface {
            public function startUnaryCall(\Google\ApiCore\Call $call, array $options)
            {
                StoresTest::$sent[] = $call->getMethod();
                $type = $call->getDecodeType();

                return new \GuzzleHttp\Promise\FulfilledPromise($type === null ? null : new $type());
            }

            public function startServerStreamingCall(\Google\ApiCore\Call $call, array $options)
            {
                StoresTest::$sent[] = $call->getMethod();
            }

            public function startClientStreamingCall(\Google\ApiCore\Call $call, array $options)
            {
                StoresTest::$sent[] = $call->getMethod();
            }

            public function startBidiStreamingCall(\Google\ApiCore\Call $call, array $options)
            {
                StoresTest::$sent[] = $call->getMethod();
            }

            public function close()
            {
            }
        };
        putenv('FIRESTORE_EMULATOR_HOST=127.0.0.1:1');
        try {
            return new \Google\Cloud\Firestore\FirestoreClient(['projectId' => 'bench', 'transport' => $transport]);
        } finally {
            putenv('FIRESTORE_EMULATOR_HOST');
        }
    }

    public function testSearchAndFirestoreClientsAreHookedByTheirServiceConfigurators(): void
    {
        self::$sent = [];
        $settings = (new Processor())->processConfiguration(new Configuration(), [['enabled' => true, 'data_stores' => [
            'elasticsearch' => ['clients' => ['app.es'], 'name' => 'search', 'path_prefix' => '/proxy'],
            'opensearch' => ['clients' => ['app.os'], 'name' => 'articles'],
            'firestore' => ['clients' => ['app.fs'], 'name' => 'docs'],
        ]]]);
        $container = new ContainerBuilder();
        $container->setParameter('kernel.environment', 'dev');
        $container->setParameter('sendproof.settings', $settings);
        $container->register(Recorder::class, Recorder::class)->setPublic(true);
        $container->register('sendproof.manager', \stdClass::class)->setArguments([null, null, null, null, null, null, null, null, null])->setPublic(true);
        $container->register('app.es', \Elastic\Elasticsearch\Client::class)->setFactory([self::class, 'elasticsearchClient'])->setPublic(true);
        $container->register('app.os', \OpenSearch\Client::class)->setFactory([self::class, 'opensearchClient'])->setPublic(true);
        $container->register('app.fs', \Google\Cloud\Firestore\FirestoreClient::class)->setFactory([self::class, 'firestoreClient'])->setPublic(true);
        (new DataStorePass())->process($container);
        $container->getDefinition(HookedStores::class)->setPublic(true);
        $container->compile();
        $recorder = $container->get(Recorder::class);

        $recorder->begin(true);
        // Reads run, even under the configured path prefix.
        $container->get('app.es')->search(['index' => 'articles', 'body' => ['query' => ['match_all' => new \stdClass()]]]);
        $container->get('app.os')->search(['index' => 'articles', 'body' => ['query' => ['match_all' => new \stdClass()]]]);
        $this->assertSame(['POST /articles/_search', 'POST /articles/_search'], self::$sent);
        foreach ([
            'Elasticsearch' => fn () => $container->get('app.es')->index(['index' => 'articles', 'id' => '1', 'body' => ['t' => 1]]),
            'OpenSearch' => fn () => $container->get('app.os')->delete(['index' => 'articles', 'id' => '1']),
            'Firestore' => fn () => $container->get('app.fs')->collection('orders')->document('o-1')->delete(),
        ] as $store => $write) {
            try {
                $write();
                $this->fail("{$store} write was not refused.");
            } catch (PreviewWriteBlockedException $refusal) {
                $this->assertStringContainsString($store, $refusal->getMessage());
            }
        }
        $this->assertCount(2, self::$sent, 'No write reached a store.');
        $this->assertEqualsCanonicalizing(['elasticsearch', 'opensearch', 'firestore'], array_map(static fn ($store): string => $store->system(), $container->get(HookedStores::class)->all()));
    }

    public function testNothingIsHookedWhenSendproofIsDisabledOrTheEnvironmentIsNotListed(): void
    {
        foreach ([['enabled' => false], ['enabled' => true, 'environments' => ['test']]] as $enabled) {
            $container = $this->container($enabled + ['data_stores' => ['redis' => ['clients' => ['app.redis']]]]);
            $container->compile();
            $this->assertFalse($container->has(HookedStores::class));
            $container->get(Recorder::class)->begin(true);
            $this->assertNotNull($container->get('app.redis'), 'The client is left untouched.');
            $this->assertCount(0, $container->get('app.redis')->getCommandFactory()->getProcessor() === null ? [] : [1]);
        }
    }

    public function testAListedServiceThatDoesNotExistFailsTheContainerBuild(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('app.cache');
        $this->container(['enabled' => true, 'data_stores' => ['redis' => ['clients' => ['app.cache']]]]);
    }

    public function testStoreNamesMustBeDisplayLabels(): void
    {
        $container = $this->container(['enabled' => true, 'data_stores' => ['redis' => ['clients' => ['app.redis'], 'name' => 'redis://:secret@host']]]);
        $container->compile();
        $this->expectException(\InvalidArgumentException::class);
        $container->get(HookedStores::class)->all();
    }

    private function catalog(): RouteCatalog
    {
        $collection = new RouteCollection();
        $collection->add('create', (new Route('/sessions', ['_controller' => UnavailableController::class . '::create']))->setMethods(['POST']));
        $collection->add('clear', (new Route('/sessions/{id}', ['_controller' => UnavailableController::class . '::clear']))->setMethods(['DELETE']));
        $collection->add('refresh', (new Route('/sessions/{id}/refresh', ['_controller' => UnavailableController::class . '::refresh']))->setMethods(['POST']));
        $collection->add('route', (new Route('/legacy', ['_controller' => 'x::y', '_sendproof_preview' => false, '_sendproof_reason' => 'Sends a real email']))->setMethods(['POST']));

        return new RouteCatalog(new Router(new ClosureLoader(), static fn () => $collection, ['resource_type' => 'closure']));
    }

    public function testAllowPreviewFalseMarksAnOperationUnavailableWithItsReason(): void
    {
        $catalog = $this->catalog();
        $this->assertSame([['method' => 'POST', 'path' => '/sessions']], $catalog->operations());
        $this->assertSame([
            ['method' => 'POST', 'path' => '/legacy', 'reason' => 'Sends a real email'],
            ['method' => 'DELETE', 'path' => '/sessions/{id}', 'reason' => 'Clears the Redis session', 'stores' => ['redis']],
            ['method' => 'POST', 'path' => '/sessions/{id}/refresh', 'reason' => 'Preview unavailable: this operation writes to Redis', 'stores' => ['redis']],
        ], $catalog->unavailable());
        $this->assertFalse($catalog->isMarked($catalog->match(Request::create('/sessions/1', 'DELETE'))), 'A Preview of an unavailable operation finds no marked route.');
    }

    public function testAnUnavailableMarkNeedsAReasonOrAStore(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new AllowPreview(false);
    }

    public function testDiscoveryReportsTheBindingTheStoresAndTheDatabaseSystem(): void
    {
        $settings = (new Processor())->processConfiguration(new Configuration(), [['enabled' => true, 'data_stores' => ['redis' => ['clients' => ['app.redis'], 'name' => 'cache']]]]);
        $stores = new HookedStores(new ServiceLocator(['app.redis' => static fn () => new PredisClient()]), $settings['data_stores']);
        $registry = $this->createStub(ManagerRegistry::class);
        $registry->method('getConnection')->willReturn($this->connection);
        $provider = new DoctrinePreviewProvider($registry, $this->collector, ['default'], 'inventory');
        $manager = new SendproofManager($settings, 'dev', sys_get_temp_dir(), $this->recorder, new DefaultIdentityResolver(), $provider, null, null, $stores);

        $capabilities = json_decode((new WorkbenchController($manager, $this->catalog()))->capabilities(Request::create('/sendproof/_api/capabilities'))->getContent(), true);
        $this->assertSame(['language' => 'php', 'framework' => 'Symfony'], $capabilities['binding']);
        $this->assertSame(['name' => 'inventory', 'system' => 'sqlite'], $capabilities['database']);
        $this->assertSame([['system' => 'redis', 'name' => 'cache', 'mode' => 'guard']], $capabilities['dataStores']);
        $this->assertCount(3, $capabilities['previewUnavailable']);
    }

    public function testPreviewRunsWithoutASqlProviderWhenStoresAreHooked(): void
    {
        $settings = (new Processor())->processConfiguration(new Configuration(), [['enabled' => true, 'provider' => null]]);
        $stores = new HookedStores(new ServiceLocator(['app.redis' => static fn () => new PredisClient()]), ['redis' => ['clients' => ['app.redis']]]);
        $this->assertNull((new SendproofManager($settings, 'dev', sys_get_temp_dir(), $this->recorder, new DefaultIdentityResolver()))->previewProvider());
        $this->assertTrue((new SendproofManager($settings, 'dev', sys_get_temp_dir(), $this->recorder, new DefaultIdentityResolver(), null, null, null, $stores))->previewProvider()->isAvailable());
    }

    public function testAStatementThatEndsTheTransactionIsRefusedAndFailsThePreviewEvenWhenCaught(): void
    {
        foreach (['COMMIT', 'ROLLBACK', 'BEGIN', 'SET autocommit = 1'] as $sql) {
            $this->recorder->begin(true);
            $this->connection->beginTransaction();
            $this->connection->executeStatement("insert into widgets (id, name) values ('w-" . md5($sql) . "', 'escaped')");
            try {
                $this->connection->executeStatement($sql);
                $this->fail("{$sql} was not refused.");
            } catch (\Throwable $error) {
                $this->assertInstanceOf(PreviewTransactionControlException::class, $error->getPrevious() ?? $error, $sql);
            }
            $this->assertNotNull($this->recorder->fault(), "{$sql} must fail the Preview even when the handler catches it.");
            $this->connection->rollBack();
            $this->recorder->finish();
        }
        $this->assertSame(0, $this->rowCount(), 'The refused statements never reached the database.');
    }

    public function testADriverLevelCommitIsRefusedButSavepointsStayAllowed(): void
    {
        $registry = $this->createStub(ManagerRegistry::class);
        $registry->method('getConnection')->willReturn($this->connection);
        $this->connection->setNestTransactionsWithSavepoints(true);
        $session = (new DoctrinePreviewProvider($registry, $this->collector))->begin(null);
        $this->recorder->begin(true);
        $this->connection->beginTransaction();
        $this->connection->executeStatement("insert into widgets (id, name) values ('nested', 'n')");
        $this->connection->commit();
        $this->assertNull($this->recorder->fault(), 'Releasing a savepoint is not a commit.');
        try {
            $this->connection->commit();
            $this->fail('The outermost commit must be refused.');
        } catch (\Throwable $error) {
            $this->assertInstanceOf(PreviewTransactionControlException::class, $error->getPrevious() ?? $error);
        }
        $this->assertNotNull($this->recorder->fault());
        try {
            $session->rollback();
            $this->fail('A Preview whose handler tried to commit is never confirmed.');
        } catch (\RuntimeException) {
            // The runner answers 500 for this.
        }
        $session->dispose();
        $this->assertSame(0, $this->rowCount(), 'Nothing is persisted, and no transaction is left open on the connection.');
        $this->assertFalse($this->connection->getNativeConnection()->inTransaction());
    }

    public function testASendMayCommitNormally(): void
    {
        $this->recorder->begin(false);
        $this->connection->beginTransaction();
        $this->connection->executeStatement("insert into widgets (id, name) values ('sent', 's')");
        $this->connection->commit();
        $this->assertSame(1, $this->rowCount());
    }
}

final class UnavailableController
{
    #[AllowPreview]
    public function create(): void
    {
    }

    #[AllowPreview(false, 'Clears the Redis session', ['redis'])]
    public function clear(): void
    {
    }

    #[AllowPreview(false, stores: ['redis'])]
    public function refresh(): void
    {
    }
}
