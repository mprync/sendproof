<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Tests;

/** Enabled in config but running in an environment that is not allow-listed, such as production. */
final class UnlistedEnvironmentTest extends TestCase
{
    protected function defineEnvironment($app): void
    {
        parent::defineEnvironment($app);
        $app['config']->set('sendproof.environments', ['local']);
    }

    public function testNothingIsMounted(): void
    {
        $this->signIn();

        $this->getJson('/sendproof/_api/capabilities')->assertNotFound();
        $this->preview('/widgets', ['id' => 'x', 'name' => 'x'])->assertNotFound();
        $this->assertSame(0, $this->widgetCount());
    }
}
