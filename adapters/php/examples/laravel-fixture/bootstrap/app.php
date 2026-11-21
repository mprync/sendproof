<?php

declare(strict_types=1);

use Fixture\Http\Middleware\RequireAdmin;
use Fixture\Http\Middleware\RequireUser;
use Fixture\Providers\FixtureServiceProvider;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;

return Application::configure(basePath: dirname(__DIR__))
    ->withProviders([FixtureServiceProvider::class])
    ->withRouting(api: __DIR__ . '/../routes/fixture.php', apiPrefix: '')
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->alias(['fixture.user' => RequireUser::class, 'fixture.admin' => RequireAdmin::class]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(fn () => true);
    })
    ->create()
    ->useStoragePath((string) getenv('FIXTURE_DIR') . '/storage');
