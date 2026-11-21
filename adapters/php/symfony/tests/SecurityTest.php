<?php

declare(strict_types=1);

namespace TestBench\Symfony\Tests;

use Doctrine\Persistence\ManagerRegistry;
use Symfony\Component\Config\Definition\Processor;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Event\ControllerEvent;
use Symfony\Component\HttpKernel\HttpKernelInterface;
use Symfony\Component\Routing\Loader\ClosureLoader;
use Symfony\Component\Routing\RouteCollection;
use Symfony\Component\Routing\Router;
use Symfony\Component\Security\Core\Authentication\Token\Storage\TokenStorage;
use Symfony\Component\Security\Core\Authentication\Token\UsernamePasswordToken;
use Symfony\Component\Security\Core\User\InMemoryUser;
use TestBench\Core\Capture\Recorder;
use TestBench\Core\Preview\PreviewState;
use TestBench\Symfony\Controller\WorkbenchController;
use TestBench\Symfony\DependencyInjection\Configuration;
use TestBench\Symfony\Doctrine\DoctrinePreviewProvider;
use TestBench\Symfony\Http\ExecutionListener;
use TestBench\Symfony\Http\PreviewListener;
use TestBench\Symfony\Http\RouteCatalog;
use TestBench\Symfony\Identity\DefaultIdentityResolver;
use TestBench\Symfony\TestBenchManager;
use TestBench\Symfony\Tests\Entity\AccessToken;

/** Regression tests from the security review: authorization, owner scoping, secrets and rollback integrity. */
final class SecurityTest extends DoctrineTestCase
{
    /** @param array<string,mixed> $overrides */
    private function manager(array $overrides, ?TokenStorage $tokens = null): TestBenchManager
    {
        $config = (new Processor())->processConfiguration(new Configuration(), [['enabled' => true] + $overrides]);

        return new TestBenchManager($config, 'dev', sys_get_temp_dir(), new Recorder(), new DefaultIdentityResolver(), null, $tokens);
    }

    private function controllerEvent(string $mode, PreviewState $state): ControllerEvent
    {
        $request = Request::create('/widgets', 'POST');
        $request->attributes->set(PreviewListener::STATE, $state);
        $request->attributes->set(PreviewListener::MODE, $mode);

        return new ControllerEvent($this->createStub(HttpKernelInterface::class), static fn (): Response => new Response('real'), $request, HttpKernelInterface::MAIN_REQUEST);
    }

    public function testAnObservedSendByAnUnauthorizedUserRunsUntouchedWithoutATrace(): void
    {
        $listener = new ExecutionListener($this->manager(['authorize' => 'ROLE_ADMIN']));
        $state = new PreviewState(hrtime(true));
        $observed = $this->controllerEvent('observe', $state);
        $preview = $this->controllerEvent('preview', new PreviewState(hrtime(true)));

        $listener->onController($observed);
        $listener->onController($preview);

        $this->assertSame('real', ($observed->getController())()->getContent(), 'the application response is never altered');
        $this->assertFalse($state->reached);
        $this->assertNull($state->owner);
        $this->assertSame(403, ($preview->getController())()->getStatusCode());
    }

    public function testTraceOwnersAreScopedToTheFirewall(): void
    {
        $user = new InMemoryUser('alice', null);
        $owner = function (string $firewall) use ($user): ?string {
            $tokens = new TokenStorage();
            $tokens->setToken(new UsernamePasswordToken($user, $firewall));

            return $this->manager([], $tokens)->ownerKey(new Request());
        };

        $this->assertNotNull($owner('main'));
        $this->assertNotSame($owner('main'), $owner('admin'));
    }

    public function testDiscoveryRefusesUrlsThatLeaveTheApplication(): void
    {
        $catalog = new RouteCatalog(new Router(new ClosureLoader(), static fn () => new RouteCollection(), ['resource_type' => 'closure']));
        $controller = new WorkbenchController($this->manager(['auth_providers' => [['label' => 'SSO', 'kind' => 'oidc', 'url' => '//evil.example/login']]]), $catalog);

        $this->expectException(\InvalidArgumentException::class);
        $controller->capabilities(new Request());
    }

    public function testASecretPrimaryKeyIsRedactedInChangeSnapshots(): void
    {
        $this->connection->executeStatement('create table access_tokens (token varchar(64) primary key not null, label varchar(255) not null)');
        $session = $this->provider()->begin(null);

        $this->em->persist(new AccessToken('plain-token-value', 'CLI'));
        $this->em->flush();
        $session->rollback();
        $changes = $session->changes();
        $session->dispose();

        $this->assertSame(['token' => '[REDACTED]'], $changes[0]['key']);
        $this->assertStringNotContainsString('plain-token-value', json_encode($changes));
    }

    public function testARawCommitIsNeverConfirmedAsARollback(): void
    {
        $session = $this->provider()->begin(null);
        $this->connection->executeStatement("insert into widgets (id, name) values ('w1', 'escaped')");
        $this->connection->getNativeConnection()->exec('COMMIT');

        try {
            $session->rollback();
            $this->fail('A rollback after a raw COMMIT must not be confirmed.');
        } catch (\Throwable $error) {
            $this->assertNotInstanceOf(\PHPUnit\Framework\AssertionFailedError::class, $error);
        } finally {
            $session->dispose();
        }
    }

    private function provider(): DoctrinePreviewProvider
    {
        $registry = $this->createStub(ManagerRegistry::class);
        $registry->method('getConnection')->willReturn($this->connection);

        return new DoctrinePreviewProvider($registry, $this->collector, ['default']);
    }
}
