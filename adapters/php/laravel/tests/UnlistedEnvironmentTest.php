<?php

declare(strict_types=1);

namespace TestBench\Laravel\Tests;

/** Enabled in config but running in an environment that is not allow-listed, such as production. */
final class UnlistedEnvironmentTest extends TestCase
{
    protected function defineEnvironment($app): void
    {
        parent::defineEnvironment($app);
        $app['config']->set('testbench.environments', ['local']);
    }

    public function testNothingIsMounted(): void
    {
        $this->signIn();

        $this->getJson('/bench/_api/capabilities')->assertNotFound();
        $this->preview('/widgets', ['id' => 'x', 'name' => 'x'])->assertNotFound();
        $this->assertSame(0, $this->widgetCount());
    }
}
