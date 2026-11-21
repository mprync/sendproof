<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Tests;

use Illuminate\Auth\GenericUser;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Schema;
use Orchestra\Testbench\TestCase as Orchestra;
use Sendproof\Laravel\Facades\Sendproof;
use Sendproof\Laravel\SendproofServiceProvider;

/** An in-memory SQLite application with a handful of opted-in and ordinary routes. */
abstract class TestCase extends Orchestra
{
    protected function getPackageProviders($app): array
    {
        return [SendproofServiceProvider::class];
    }

    protected function defineEnvironment($app): void
    {
        $app['config']->set('database.default', 'testing');
        $app['config']->set('database.connections.testing', ['driver' => 'sqlite', 'database' => ':memory:', 'prefix' => '']);
        $app['config']->set('mail.default', 'array');
        $app['config']->set('sendproof.enabled', true);
        $app['config']->set('sendproof.environments', ['testing']);
        $app['config']->set('sendproof.trace.path', sys_get_temp_dir() . '/sendproof-laravel-traces-' . getmypid());
        $app['config']->set('sendproof.guard', 'web');
        $app['config']->set('sendproof.middleware', []);
    }

    protected function defineDatabaseMigrations(): void
    {
        Schema::create('widgets', function ($table): void {
            $table->string('id')->primary();
            $table->string('name');
            $table->string('api_token')->nullable();
        });
    }

    protected function defineRoutes($router): void
    {
        Route::middleware([RequireUser::class])->group(function (): void {
            Route::post('/widgets', function () {
                $widget = Widget::create(['id' => request('id'), 'name' => request('name'), 'api_token' => 'tok']);
                Log::info('created:' . $widget->id);
                Sendproof::tryRecordEffect('message', 'Widget created', ['id' => $widget->id]);
                DB::select('select ? as value', ['bound-value']);

                return response()->json($widget->only(['id', 'name']), 201);
            })->sendproofPreview();

            Route::patch('/widgets/{id}', function (string $id) {
                Widget::findOrFail($id)->update(['name' => request('name')]);

                return response()->json(['id' => $id, 'name' => request('name')]);
            })->sendproofPreview();

            Route::delete('/widgets/{id}', function (string $id) {
                Widget::findOrFail($id)->delete();

                return response()->noContent();
            })->sendproofPreview();

            Route::post('/widgets/{id}/boom', function (string $id) {
                Widget::create(['id' => $id, 'name' => 'boom']);
                throw new \RuntimeException('Unhandled failure.');
            })->sendproofPreview();

            Route::post('/widgets/{id}/conflict', function (string $id) {
                Widget::create(['id' => $id, 'name' => 'conflict']);

                return response()->json(['title' => 'Conflict'], 409);
            })->sendproofPreview();

            Route::post('/widgets/{id}/nested', function (string $id) {
                try {
                    DB::transaction(function () use ($id): void {
                        Widget::create(['id' => $id . '-discarded', 'name' => 'discarded']);
                        throw new \RuntimeException('Roll back the savepoint.');
                    });
                } catch (\RuntimeException) {
                    // The savepoint is rolled back; the preview continues.
                }
                Widget::create(['id' => $id, 'name' => 'kept']);

                return response()->json(['id' => $id]);
            })->sendproofPreview();

            Route::post('/widgets/{id}/commit', function (string $id) {
                Widget::create(['id' => $id, 'name' => 'committed']);
                DB::commit();

                return response()->json(['id' => $id]);
            })->sendproofPreview();

            Route::post('/widgets/{id}/mail', function (string $id) {
                Mail::raw('Hello body', fn ($message) => $message->to('person@example.test')->subject('Hello ' . $id));

                return response()->json(['id' => $id]);
            })->sendproofPreview();

            Route::post('/widgets/{id}/ordinary', function (string $id) {
                Widget::create(['id' => $id, 'name' => 'ordinary']);

                return response()->json(['id' => $id], 201);
            });
        });
    }

    protected function signIn(string $id = '1', string $name = 'Alex', string $role = 'admin'): static
    {
        return $this->actingAs(new GenericUser(['id' => $id, 'name' => $name, 'role' => $role]));
    }

    /** @param array<string,mixed> $body */
    protected function preview(string $path, array $body = [], string $method = 'POST', array $headers = []): \Illuminate\Testing\TestResponse
    {
        return $this->json($method, '/sendproof/_preview' . $path, $body, ['Prefer' => 'tx=rollback'] + $headers);
    }

    protected function widgetCount(): int
    {
        return DB::table('widgets')->count();
    }
}

/** Anonymous callers receive 401, like a typical API guard. */
final class RequireUser
{
    public function handle($request, \Closure $next)
    {
        return auth()->check() ? $next($request) : response()->json(['title' => 'Unauthenticated'], 401);
    }
}

/** @property string $id */
final class Widget extends Model
{
    public $incrementing = false;
    public $timestamps = false;
    protected $keyType = 'string';
    protected $table = 'widgets';
    protected $fillable = ['id', 'name', 'api_token'];
    protected $hidden = ['api_token'];
}
