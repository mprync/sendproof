<?php

declare(strict_types=1);

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;

// A bare Laravel application: one routes file, no sessions or views. sendproof/laravel is
// auto-discovered from vendor/ and mounts /sendproof/ because SENDPROOF_ENABLED=true and
// APP_ENV is listed in SENDPROOF_ENVIRONMENTS (both set by the release smoke test).
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(api: __DIR__ . '/../routes/api.php', apiPrefix: '')
    ->withMiddleware(function (Middleware $middleware): void {})
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(fn () => true);
    })
    ->create()
    ->useStoragePath((string) getenv('CONSUMER_STORAGE'));
