<?php

declare(strict_types=1);

namespace TestBench\Laravel\Tests;

/** With no preview provider the workbench still opens, but advertises and runs no preview. */
final class NoProviderTest extends TestCase
{
    protected function defineEnvironment($app): void
    {
        parent::defineEnvironment($app);
        $app['config']->set('testbench.provider', null);
    }

    public function testNoOperationIsAdvertisedOrPreviewed(): void
    {
        $this->signIn();

        $this->getJson('/bench/_api/capabilities')->assertOk()
            ->assertJsonPath('previewOperations', [])
            ->assertJsonPath('observedSend', false)
            ->assertJsonPath('database', null);
        $this->preview('/widgets', ['id' => 'x', 'name' => 'x'])->assertStatus(503);
        $this->assertSame(0, $this->widgetCount());
    }
}
