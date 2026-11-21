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
