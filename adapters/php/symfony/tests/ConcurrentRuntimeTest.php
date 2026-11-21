<?php

declare(strict_types=1);

namespace Sendproof\Symfony\Tests;

use Doctrine\Persistence\ManagerRegistry;
use Sendproof\Symfony\Controller\WorkbenchController;
use Sendproof\Symfony\DependencyInjection\Configuration;
use Sendproof\Symfony\Doctrine\DoctrinePreviewProvider;
use Sendproof\Symfony\Http\PreviewListener;
use Sendproof\Symfony\Http\RouteCatalog;
use Sendproof\Symfony\Identity\DefaultIdentityResolver;
use Sendproof\Symfony\SendproofManager;
use Symfony\Component\Config\Definition\Processor;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\HttpKernelInterface;
use Symfony\Component\Routing\Loader\ClosureLoader;
use Symfony\Component\Routing\Route;
use Symfony\Component\Routing\RouteCollection;
use Symfony\Component\Routing\Router;

/**
 * A Swoole or OpenSwoole runtime runs requests concurrently in coroutines in one worker, so "every write
 * in the process belongs to the open Preview" doesn't hold there. Previews are refused before the
 * controller runs, and capabilities say why.
 */
final class ConcurrentRuntimeTest extends DoctrineTestCase
{
    protected function tearDown(): void
    {
        unset($_SERVER['APP_RUNTIME']);
        parent::tearDown();
    }

    /** @param array<string,mixed> $overrides */
    private function manager(array $overrides = []): SendproofManager
    {
        $settings = (new Processor())->processConfiguration(new Configuration(), [['enabled' => true] + $overrides]);
        $registry = $this->createStub(ManagerRegistry::class);
        $registry->method('getConnection')->willReturn($this->connection);
        $provider = new DoctrinePreviewProvider($registry, $this->collector, ['default'], 'inventory');

        return new SendproofManager($settings, 'dev', sys_get_temp_dir(), $this->recorder, new DefaultIdentityResolver(), $provider);
    }

    private function catalog(): RouteCatalog
    {
        $collection = new RouteCollection();
        $collection->add('create', (new Route('/widgets', ['_controller' => 'x::y', '_sendproof_preview' => true]))->setMethods(['POST']));

        return new RouteCatalog(new Router(new ClosureLoader(), static fn () => $collection, ['resource_type' => 'closure']));
    }

    public function testASwooleRuntimeIsDetectedAndOneRequestPerWorkerRuntimesAreNot(): void
    {
        $this->assertNull($this->manager()->concurrencyReason(), 'php-fpm and php -S run one request per process.');
        foreach (['Runtime\\Swoole\\Runtime' => true, 'Runtime\\OpenSwoole\\Runtime' => true, 'Runtime\\RoadRunnerSymfonyNyholm\\Runtime' => false,
            'Runtime\\FrankenPhpSymfony\\Runtime' => false, 'Symfony\\Component\\Runtime\\SymfonyRuntime' => false] as $runtime => $concurrent) {
            $_SERVER['APP_RUNTIME'] = $runtime;
            $this->assertSame($concurrent, $this->manager()->concurrencyReason() !== null, $runtime);
        }
        $_SERVER['APP_RUNTIME'] = 'Runtime\\Swoole\\Runtime';
        $this->assertNull($this->manager(['concurrent_workers' => false])->concurrencyReason(), 'A host may allow a server it runs one request per worker.');
        unset($_SERVER['APP_RUNTIME']);
        $this->assertNotNull($this->manager(['concurrent_workers' => true])->concurrencyReason(), 'A host may refuse explicitly.');
    }

    public function testAPreviewUnderAConcurrentRuntimeIsRefusedBeforeTheControllerRunsAndCapabilitiesSayWhy(): void
    {
        $_SERVER['APP_RUNTIME'] = 'Runtime\\Swoole\\Runtime';
        $manager = $this->manager();
        $kernel = $this->createMock(HttpKernelInterface::class);
        $kernel->expects($this->never())->method('handle');
        $listener = new PreviewListener($kernel, $manager, $this->catalog());
        $request = Request::create('/sendproof/_preview/widgets', 'POST', server: ['HTTP_PREFER' => 'tx=rollback']);
        $event = new RequestEvent($kernel, $request, HttpKernelInterface::MAIN_REQUEST);

        $listener->onRequest($event);

        $this->assertSame(409, $event->getResponse()?->getStatusCode());
        $this->assertSame(SendproofManager::CONCURRENT_WORKER_REASON, json_decode((string) $event->getResponse()->getContent(), true)['title']);
        $this->assertSame(0, $this->rowCount());

        $capabilities = json_decode((string) (new WorkbenchController($manager, $this->catalog()))->capabilities(Request::create('/sendproof/_api/capabilities'))->getContent(), true);
        $this->assertSame([], $capabilities['previewOperations'] ?? []);
        $this->assertSame([['method' => 'POST', 'path' => '/widgets', 'reason' => SendproofManager::CONCURRENT_WORKER_REASON]], $capabilities['previewUnavailable']);
    }
}
