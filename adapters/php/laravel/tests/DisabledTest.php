<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Tests;

/** The workbench is opt-in: with the switch off nothing is mounted and previews are refused. */
final class DisabledTest extends TestCase
{
    protected function defineEnvironment($app): void
    {
        parent::defineEnvironment($app);
        $app['config']->set('sendproof.enabled', false);
    }

    public function testNothingIsMountedAndNoPreviewRuns(): void
    {
        $this->signIn();

        $this->getJson('/sendproof/_api/capabilities')->assertNotFound();
        $this->get('/sendproof')->assertNotFound();
        $this->preview('/widgets', ['id' => 'x', 'name' => 'x'])->assertNotFound();
        $this->assertSame(0, $this->widgetCount());
    }

    public function testOrdinaryRoutesAndObservedSendRequestsStillWorkWithoutATrace(): void
    {
        $this->signIn();

        $response = $this->json('POST', '/widgets', ['id' => 'x', 'name' => 'x'], ['Prefer' => 'trace'])->assertCreated();

        $this->assertNull($response->headers->get('X-Sendproof-Trace'));
        $this->assertSame(1, $this->widgetCount());
    }
}
