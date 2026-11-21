<?php

declare(strict_types=1);

namespace TestBench\Symfony\Tests;

use PHPUnit\Framework\TestCase;
use Symfony\Component\Config\Definition\Processor;
use Symfony\Component\DependencyInjection\ContainerBuilder;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Loader\ClosureLoader;
use Symfony\Component\Routing\Route;
use Symfony\Component\Routing\RouteCollection;
use Symfony\Component\Routing\Router;
use TestBench\Core\Capture\Recorder;
use TestBench\Core\Contracts\PreviewProvider;
use TestBench\Symfony\Attribute\AllowPreview;
use TestBench\Symfony\DependencyInjection\Configuration;
use TestBench\Symfony\DependencyInjection\TestBenchExtension;
use TestBench\Symfony\Http\RouteCatalog;
use TestBench\Symfony\Identity\DefaultIdentityResolver;
use TestBench\Symfony\TestBenchBundle;
use TestBench\Symfony\TestBenchManager;

final class BundleTest extends TestCase
{
    public function testEverythingIsOffByDefaultAndProductionIsNotListed(): void
    {
        $config = (new Processor())->processConfiguration(new Configuration(), [[]]);

        $this->assertFalse($config['enabled']);
        $this->assertSame(['dev'], $config['environments']);
        $this->assertSame('doctrine', $config['provider']);
        $this->assertSame(['default'], $config['connections']);
        $this->assertSame(300, $config['trace']['ttl']);
    }

    public function testTheBundleUsesTheTestbenchAlias(): void
    {
        $this->assertSame('testbench', (new TestBenchBundle())->getContainerExtension()->getAlias());
    }

    /** @param array<string,mixed> $config */
    private function container(array $config): ContainerBuilder
    {
        $container = new ContainerBuilder();
        $container->setParameter('kernel.environment', 'dev');
        $container->setParameter('kernel.project_dir', sys_get_temp_dir());
        (new TestBenchExtension())->load([$config], $container);

        return $container;
    }

    public function testTheDoctrineProviderIsTheDefault(): void
    {
        $container = $this->container(['enabled' => true]);

        $this->assertSame('TestBench\Symfony\Doctrine\DoctrinePreviewProvider', (string) $container->getAlias(PreviewProvider::class));
        $this->assertSame('TestBench\Symfony\Identity\DefaultIdentityResolver', (string) $container->getAlias('testbench.identity'));
    }

    public function testAProviderCanBeDisabledOrReplaced(): void
    {
        $none = $this->container(['provider' => null]);
        $custom = $this->container(['provider' => 'app.provider', 'identity' => 'app.identity']);

        $this->assertFalse($none->hasAlias(PreviewProvider::class));
        $this->assertNull($none->getDefinition('testbench.manager')->getArgument(5));
        $this->assertSame('app.provider', (string) $custom->getAlias(PreviewProvider::class));
        $this->assertSame('app.identity', (string) $custom->getAlias('testbench.identity'));
    }

    /** @param array<string,mixed> $overrides */
    private function manager(array $overrides): TestBenchManager
    {
        $config = (new Processor())->processConfiguration(new Configuration(), [$overrides]);

        return new TestBenchManager($config, $overrides['_env'] ?? 'dev', sys_get_temp_dir(), new Recorder(), new DefaultIdentityResolver());
    }

    public function testTheWorkbenchRequiresTheSwitchAndAnAllowListedEnvironment(): void
    {
        $this->assertFalse($this->manager([])->enabled());
        $this->assertTrue($this->manager(['enabled' => true])->enabled());
        $this->assertFalse((new TestBenchManager(
            (new Processor())->processConfiguration(new Configuration(), [['enabled' => true]]),
            'prod', sys_get_temp_dir(), new Recorder(), new DefaultIdentityResolver(),
        ))->enabled());
    }

    public function testSqlValuesAreShownInDevAndTestOnlyUnlessConfigured(): void
    {
        $settings = static fn (array $extra) => (new Processor())->processConfiguration(new Configuration(), [$extra]);
        $make = static fn (string $env, array $extra = []) => new TestBenchManager($settings($extra), $env, sys_get_temp_dir(), new Recorder(), new DefaultIdentityResolver());

        $this->assertTrue($make('dev')->showSqlValues());
        $this->assertFalse($make('prod')->showSqlValues());
        $this->assertTrue($make('prod', ['include_sql_parameter_values' => true])->showSqlValues());
    }

    public function testAnonymousRequestsHaveNoIdentityAndNoTraceOwner(): void
    {
        $manager = $this->manager(['enabled' => true]);

        $this->assertNull($manager->identity(new Request()));
        $this->assertNull($manager->ownerKey(new Request()));
        $this->assertTrue($manager->authorized());
    }

    public function testAuthorizationFailsClosedWithoutASecurityChecker(): void
    {
        $this->assertFalse($this->manager(['authorize' => 'ROLE_ADMIN'])->authorized());
    }

    public function testRouteCatalogFindsAttributeAndDefaultMarkersAndSkipsOthers(): void
    {
        $collection = new RouteCollection();
        $collection->add('marked', (new Route('/widgets', ['_controller' => MarkedController::class . '::create']))->setMethods(['POST']));
        $collection->add('class_marked', (new Route('/all/{id}', ['_controller' => ClassMarkedController::class]))->setMethods(['PATCH', 'HEAD']));
        $collection->add('default_marked', (new Route('/legacy', ['_controller' => 'x::y', '_testbench_preview' => true]))->setMethods(['DELETE']));
        $collection->add('plain', (new Route('/widgets/plain', ['_controller' => MarkedController::class . '::plain']))->setMethods(['POST']));
        $catalog = new RouteCatalog(new Router(new ClosureLoader(), static fn () => $collection, ['resource_type' => 'closure']));

        $this->assertSame([
            ['method' => 'PATCH', 'path' => '/all/{id}'],
            ['method' => 'DELETE', 'path' => '/legacy'],
            ['method' => 'POST', 'path' => '/widgets'],
        ], $catalog->operations());
        $this->assertTrue($catalog->isMarked($catalog->match(Request::create('/widgets', 'POST'))));
        $this->assertFalse($catalog->isMarked($catalog->match(Request::create('/widgets/plain', 'POST'))));
    }
}

final class MarkedController
{
    #[AllowPreview]
    public function create(): void
    {
    }

    public function plain(): void
    {
    }
}

#[AllowPreview]
final class ClassMarkedController
{
    public function __invoke(): void
    {
    }
}
