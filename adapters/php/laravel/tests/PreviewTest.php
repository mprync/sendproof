<?php

declare(strict_types=1);

namespace TestBench\Laravel\Tests;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;

final class PreviewTest extends TestCase
{
    public function testPreviewRollsBackAndCapturesChangesLogsEffectsAndSql(): void
    {
        $this->signIn();

        $response = $this->preview('/widgets', ['id' => 'w1', 'name' => 'Bolt']);

        $response->assertOk()->assertHeader('Preference-Applied', 'tx=rollback');
        $this->assertStringContainsString('no-store', $response->headers->get('Cache-Control'));
        $this->assertNull($response->headers->get('Set-Cookie'));
        $envelope = $response->json();
        $this->assertSame(201, $envelope['status']);
        $this->assertSame(['id' => 'w1', 'name' => 'Bolt'], $envelope['body']);
        $this->assertTrue($envelope['rolledBack']);
        $this->assertSame(0, $this->widgetCount());

        $change = $envelope['changes'][0];
        $this->assertSame(['insert', 'widgets', ['id' => 'w1']], [$change['operation'], $change['table'], $change['key']]);
        $this->assertNull($change['before']);
        $this->assertSame('Bolt', $change['after']['name']);
        $this->assertSame('[REDACTED]', $change['after']['api_token'], 'hidden attributes are redacted');

        $this->assertSame('message', $envelope['effects'][0]['kind']);
        $this->assertArrayNotHasKey('delivered', $envelope['effects'][0]);
        $this->assertContains('created:w1', array_column($envelope['logs'], 'message'));
        $sql = array_values(array_filter(array_column($envelope['logs'], 'sql')));
        $this->assertNotEmpty($sql);
        $this->assertSame('bound-value', collect($sql)->pluck('parameters')->flatten(1)->firstWhere('value', 'bound-value')['value']);
    }

    public function testUpdateAndDeleteCarryBeforeAndAfterSnapshots(): void
    {
        $this->signIn();
        DB::table('widgets')->insert(['id' => 'w1', 'name' => 'Initial']);

        $update = $this->preview('/widgets/w1', ['name' => 'Temp'], 'PATCH')->assertOk()->json();
        $delete = $this->preview('/widgets/w1', [], 'DELETE')->assertOk()->json();

        $this->assertSame('update', $update['changes'][0]['operation']);
        $this->assertSame('Initial', $update['changes'][0]['before']['name']);
        $this->assertSame('Temp', $update['changes'][0]['after']['name']);
        $this->assertSame(204, $delete['status']);
        $this->assertNull($delete['body']);
        $this->assertSame('delete', $delete['changes'][0]['operation']);
        $this->assertNull($delete['changes'][0]['after']);
        $this->assertSame('Initial', DB::table('widgets')->value('name'));
    }

    public function testHandledApplicationFailuresAreConfirmedInside(): void
    {
        $this->signIn();

        $conflict = $this->preview('/widgets/w9/conflict')->assertOk()->json();

        $this->assertSame(409, $conflict['status']);
        $this->assertSame(0, $this->widgetCount());
    }

    public function testUnhandledExceptionsAreUnconfirmedAndRolledBack(): void
    {
        $this->signIn();

        $response = $this->preview('/widgets/w9/boom');

        $response->assertStatus(500);
        $this->assertNotTrue($response->json('rolledBack'));
        $this->assertSame(0, $this->widgetCount());
    }

    public function testNestedTransactionRollbackDoesNotLeakPhantomChanges(): void
    {
        $this->signIn();

        $envelope = $this->preview('/widgets/w1/nested')->assertOk()->json();

        $this->assertSame(['w1'], array_map(fn (array $change) => $change['key']['id'], $envelope['changes']));
        $this->assertSame(0, $this->widgetCount());
    }

    public function testAHandlerThatCommitsTheOuterTransactionIsNeverConfirmed(): void
    {
        $this->signIn();

        $response = $this->preview('/widgets/w1/commit');

        $response->assertStatus(500);
        $this->assertNotTrue($response->json('rolledBack'));
    }

    public function testMailIsCapturedAndSuppressedInAPreview(): void
    {
        $this->signIn();

        $envelope = $this->preview('/widgets/w1/mail')->assertOk()->json();

        $this->assertSame('email', $envelope['effects'][0]['kind']);
        $this->assertSame('Hello w1', $envelope['effects'][0]['data']['subject']);
        $this->assertSame(['person@example.test'], $envelope['effects'][0]['data']['to']);
        $this->assertCount(0, Mail::mailer('array')->getSymfonyTransport()->messages());
    }

    public function testRejectsInvalidTransportBeforeAnythingRuns(): void
    {
        $this->signIn();

        $this->json('POST', '/bench/_preview/widgets', ['id' => 'x', 'name' => 'x'])->assertStatus(400);
        $this->json('POST', '/bench/_preview/widgets', [], ['Prefer' => 'tx="rollback"'])->assertStatus(400);
        $this->json('POST', '/bench/_preview/widgets', [], ['Prefer' => 'trace, tx=rollback'])->assertStatus(400);
        $this->preview('/widgets', [], 'POST', ['Origin' => 'https://elsewhere.example.test'])->assertStatus(403);
        $this->preview('/widgets', [], 'POST', ['Sec-Fetch-Site' => 'cross-site'])->assertStatus(403);
        $this->call('HEAD', '/bench/_preview/widgets', [], [], [], ['HTTP_PREFER' => 'tx=rollback'])->assertStatus(405);
        $this->preview('//widgets')->assertStatus(400);
        $this->preview('/bench/_api/capabilities')->assertStatus(400);
        $this->json('POST', '/widgets', ['id' => 'x', 'name' => 'x'], ['Prefer' => 'tx=rollback'])->assertStatus(400);
        $this->assertSame(0, $this->widgetCount());
    }

    public function testUnmarkedAndUnknownTargetsNeverExecute(): void
    {
        $this->signIn();

        $this->preview('/widgets/x/ordinary')->assertStatus(409);
        $this->preview('/missing')->assertStatus(404);
        $this->assertSame(0, $this->widgetCount());
        $this->json('POST', '/widgets/x/ordinary', [], ['Prefer' => 'trace'])->assertCreated();
        $this->assertNull($this->json('POST', '/widgets/y/ordinary', [], ['Prefer' => 'trace'])->headers->get('X-TestBench-Trace'));
    }

    public function testAnonymousCallersDoNotGetAnEnvelope(): void
    {
        $response = $this->preview('/widgets', ['id' => 'x', 'name' => 'x']);

        $response->assertStatus(401);
        $this->assertNull($response->json('rolledBack'));
        $this->assertSame(0, $this->widgetCount());
    }

    public function testLeavesNoTransactionOpenAfterwards(): void
    {
        $this->signIn();
        $this->preview('/widgets', ['id' => 'w1', 'name' => 'Bolt'])->assertOk();
        $this->preview('/widgets/w2/boom')->assertStatus(500);

        $this->assertSame(0, DB::connection()->transactionLevel());
    }
}
