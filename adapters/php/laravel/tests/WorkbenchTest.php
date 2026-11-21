<?php

declare(strict_types=1);

namespace TestBench\Laravel\Tests;

use Illuminate\Support\Facades\Mail;
use Illuminate\Http\Request;
use Illuminate\Contracts\Http\Kernel;

final class WorkbenchTest extends TestCase
{
    public function testDiscoveryListsOnlyMarkedOperationsAndTheIdentity(): void
    {
        $this->signIn('1', 'Alex', 'admin');

        $capabilities = $this->getJson('/bench/_api/capabilities')->assertOk()->assertHeader('Cache-Control')->json();

        $this->assertStringContainsString('no-store', $this->get('/bench/_api/capabilities')->headers->get('Cache-Control'));
        $this->assertSame(1, $capabilities['protocolVersion']);
        $this->assertSame(['name' => 'Alex', 'role' => 'admin'], $capabilities['identity']);
        $this->assertTrue($capabilities['observedSend']);
        $this->assertContains(['method' => 'POST', 'path' => '/widgets'], $capabilities['previewOperations']);
        $this->assertContains(['method' => 'PATCH', 'path' => '/widgets/{id}'], $capabilities['previewOperations']);
        $this->assertNotContains(['method' => 'POST', 'path' => '/widgets/{id}/ordinary'], $capabilities['previewOperations']);
        $this->assertSame(':memory:', $capabilities['database']);
    }

    public function testAnonymousDiscoveryHasNoIdentity(): void
    {
        $this->getJson('/bench/_api/capabilities')->assertOk()->assertJsonPath('identity', null);
    }

    public function testServesTheEmbeddedUiWithSecurityHeaders(): void
    {
        $this->get('/bench')->assertRedirect('/bench/');
        // The test client trims trailing slashes, so send the exact URL through the kernel.
        $request = Request::create('http://localhost/bench/');
        $index = $this->createTestResponse($this->app->make(Kernel::class)->handle($request), $request)->assertOk();

        $this->assertStringContainsString('Test Bench', $index->getContent());
        $this->assertStringContainsString('no-cache', $index->headers->get('Cache-Control'));
        $this->assertSame('nosniff', $index->headers->get('X-Content-Type-Options'));
        $this->get('/bench/does-not-exist.js')->assertNotFound();
    }

    public function testMailIsDeliveredAndTracedByAnObservedSend(): void
    {
        $this->signIn();

        $response = $this->json('POST', '/widgets/w1/mail', [], ['Prefer' => 'trace'])->assertOk();

        $this->assertCount(1, Mail::mailer('array')->getSymfonyTransport()->messages());
        $trace = $this->getJson('/bench/_api/traces/' . $response->headers->get('X-TestBench-Trace'))->assertOk()->json();
        $this->assertTrue($trace['effects'][0]['delivered']);
        $this->assertSame('email', $trace['effects'][0]['kind']);
    }

    public function testObservedSendCommitsAndTheTraceBelongsToItsOwner(): void
    {
        $this->signIn('1');
        $send = $this->json('POST', '/widgets', ['id' => 'w1', 'name' => 'Bolt'], ['Prefer' => 'trace'])->assertCreated();
        $id = $send->headers->get('X-TestBench-Trace');

        $this->assertNotEmpty($id);
        $this->assertSame(1, $this->widgetCount());
        $this->assertSame(['id' => 'w1', 'name' => 'Bolt'], $send->json());
        $trace = $this->getJson('/bench/_api/traces/' . $id)->assertOk()->json();
        $this->assertStringContainsString('no-store', $this->getJson('/bench/_api/traces/' . $id)->headers->get('Cache-Control'));
        $this->assertSame('insert', $trace['changes'][0]['operation']);
        $this->assertTrue($trace['effects'][0]['delivered']);
        $this->assertContains('created:w1', array_column($trace['logs'], 'message'));
        $this->assertArrayHasKey('queryCount', $trace['timing']);

        $this->signIn('2')->getJson('/bench/_api/traces/' . $id)->assertNotFound();
    }

    public function testAnonymousAndCrossOriginSendsGetNoTrace(): void
    {
        $this->json('POST', '/widgets', ['id' => 'a', 'name' => 'a'], ['Prefer' => 'trace'])->assertStatus(401);
        $this->signIn();
        $cross = $this->json('POST', '/widgets', ['id' => 'b', 'name' => 'b'], ['Prefer' => 'trace', 'Origin' => 'https://elsewhere.example.test']);

        $cross->assertCreated();
        $this->assertNull($cross->headers->get('X-TestBench-Trace'));
    }

    public function testFailedSendsGetNoTraceHeader(): void
    {
        $this->signIn();

        $response = $this->json('POST', '/widgets/w1/boom', [], ['Prefer' => 'trace']);

        $response->assertStatus(500);
        $this->assertNull($response->headers->get('X-TestBench-Trace'));
    }
}
