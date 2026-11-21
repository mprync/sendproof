<?php

declare(strict_types=1);

namespace TestBench\Laravel\Tests;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Schema;
use TestBench\Laravel\Facades\TestBench;

/** Regression tests from the security review: authorization, secrets in captures and rollback integrity. */
final class SecurityTest extends TestCase
{
    public function testAnAuthorizeUsingClosureGatesEveryWorkbenchRoute(): void
    {
        TestBench::authorizeUsing(fn (): bool => false);

        $this->getJson('/bench/_api/capabilities')->assertStatus(401);
        $this->signIn();
        $this->getJson('/bench/_api/capabilities')->assertStatus(403);
        $this->get('/bench/app.js')->assertStatus(403);
    }

    public function testDiscoveryRefusesUrlsThatLeaveTheApplication(): void
    {
        $this->app['config']->set('testbench.field_modules', ['//evil.example/fields.js']);

        $this->getJson('/bench/_api/capabilities')->assertStatus(500);
    }

    public function testSessionTableStatementsNeverExposeTheSessionId(): void
    {
        $this->app['config']->set('session.driver', 'database');
        $this->app['config']->set('session.table', 'sessions');
        Schema::create('sessions', function ($table): void {
            $table->string('id')->primary();
            $table->text('payload');
        });
        Route::middleware([RequireUser::class])->post('/widgets/{id}/session', function (string $id) {
            // What the database session handler runs on every request.
            DB::table('sessions')->insert(['id' => 'session-id-secret', 'payload' => 'csrf-token-secret']);
            DB::select('select ? as value', ['visible-value']);

            return response()->json(['id' => $id]);
        })->testbenchPreview();
        $this->signIn();

        $envelope = $this->preview('/widgets/w1/session')->assertOk()->json();

        $values = collect($envelope['logs'])->pluck('sql')->filter()->pluck('parameters')->flatten(1)->pluck('value')->all();
        $this->assertContains('visible-value', $values, 'ordinary statements keep their values in development');
        $this->assertNotContains('session-id-secret', $values);
        $this->assertNotContains('csrf-token-secret', $values);
        $this->assertStringNotContainsString('session-id-secret', json_encode($envelope));
    }

    public function testARawCommitIsNeverConfirmedAsARollback(): void
    {
        Route::middleware([RequireUser::class])->post('/widgets/{id}/raw-commit', function (string $id) {
            Widget::create(['id' => $id, 'name' => 'escaped']);
            DB::unprepared('COMMIT');

            return response()->json(['id' => $id]);
        })->testbenchPreview();
        $this->signIn();

        $response = $this->preview('/widgets/w1/raw-commit');

        $response->assertStatus(500);
        $this->assertNotTrue($response->json('rolledBack'));
    }

    public function testASecretPrimaryKeyIsRedactedInChangeSnapshots(): void
    {
        Schema::create('access_tokens', function ($table): void {
            $table->string('token')->primary();
            $table->string('label');
        });
        Route::middleware([RequireUser::class])->post('/tokens', function () {
            AccessToken::create(['token' => 'plain-token-value', 'label' => 'CLI']);

            return response()->json(['ok' => true], 201);
        })->testbenchPreview();
        $this->signIn();

        $envelope = $this->preview('/tokens')->assertOk()->json();

        $this->assertSame(['token' => '[REDACTED]'], $envelope['changes'][0]['key']);
        $this->assertStringNotContainsString('plain-token-value', json_encode($envelope['changes']));
    }

    public function testMethodOverrideCannotSwapTheCheckedOperation(): void
    {
        Route::middleware([RequireUser::class])->delete('/widgets/{id}/unmarked', function () {
            DB::table('widgets')->insert(['id' => 'should-not-run', 'name' => 'x']);

            return response()->noContent();
        });
        Route::middleware([RequireUser::class])->post('/widgets/{id}/unmarked', fn () => response()->json(['ok' => true]))->testbenchPreview();
        $this->signIn();

        $response = $this->preview('/widgets/w1/unmarked', ['_method' => 'DELETE']);

        // The override is applied before the operation is checked, so the unmarked DELETE is refused.
        $response->assertStatus(409);
        $this->assertSame(0, $this->widgetCount());
    }
}

/** A model whose primary key is itself a secret. */
final class AccessToken extends Model
{
    public $incrementing = false;
    public $timestamps = false;
    protected $keyType = 'string';
    protected $primaryKey = 'token';
    protected $table = 'access_tokens';
    protected $fillable = ['token', 'label'];
}
