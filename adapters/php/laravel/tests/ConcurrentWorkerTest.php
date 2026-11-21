<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Tests;

use Sendproof\Laravel\SendproofManager;

/**
 * Laravel Octane on Swoole or OpenSwoole runs requests concurrently in coroutines in one worker, so
 * "every write in the process belongs to the open Preview" doesn't hold there. Previews are refused
 * before the handler runs, and capabilities say why.
 */
final class ConcurrentWorkerTest extends TestCase
{
    protected function tearDown(): void
    {
        unset($_SERVER['LARAVEL_OCTANE']);
        parent::tearDown();
    }

    public function testOctaneOnSwooleOrOpenSwooleIsDetectedAndOtherServersAreNot(): void
    {
        $manager = $this->app->make(SendproofManager::class);
        $this->assertNull($manager->concurrencyReason(), 'php-fpm and php -S run one request per process.');

        $_SERVER['LARAVEL_OCTANE'] = '1';
        foreach (['swoole' => true, 'openswoole' => true, 'roadrunner' => false, 'frankenphp' => false] as $server => $concurrent) {
            $this->app['config']->set('octane.server', $server);
            $this->assertSame($concurrent, $manager->concurrencyReason() !== null, $server);
        }

        $this->app['config']->set('octane.server', 'swoole');
        $this->app['config']->set('sendproof.concurrent_workers', false);
        $this->assertNull($manager->concurrencyReason(), 'A host may allow a Swoole server it runs one request per worker.');
        $this->app['config']->set('sendproof.concurrent_workers', true);
        unset($_SERVER['LARAVEL_OCTANE']);
        $this->assertNotNull($manager->concurrencyReason(), 'A host may refuse explicitly.');
    }

    public function testAPreviewUnderAConcurrentWorkerIsRefusedBeforeTheHandlerRunsAndCapabilitiesSayWhy(): void
    {
        $_SERVER['LARAVEL_OCTANE'] = '1';
        $this->app['config']->set('octane.server', 'swoole');
        $this->signIn();

        $response = $this->preview('/widgets', ['id' => 'w1', 'name' => 'Bolt'])->assertStatus(409);
        $this->assertStringContainsString('Swoole', (string) $response->json('title'));
        $this->assertNotTrue($response->json('rolledBack'));
        $this->assertSame(0, $this->widgetCount(), 'The handler never ran.');

        $capabilities = $this->getJson('/sendproof/_api/capabilities')->json();
        $this->assertSame([], $capabilities['previewOperations'] ?? []);
        $this->assertContains(['method' => 'POST', 'path' => '/widgets', 'reason' => SendproofManager::CONCURRENT_WORKER_REASON], $capabilities['previewUnavailable']);

        // An ordinary Send still runs and commits.
        $this->postJson('/widgets', ['id' => 'w2', 'name' => 'Nut'])->assertSuccessful();
        $this->assertSame(1, $this->widgetCount());
    }
}
