<?php

declare(strict_types=1);

namespace TestBench\Laravel;

use Illuminate\Contracts\Http\Kernel;
use Illuminate\Routing\Route as RouteDefinition;
use Illuminate\Routing\Router;
use Illuminate\Routing\RouteRegistrar;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;
use TestBench\Core\Capture\Recorder;
use TestBench\Laravel\Capture\CaptureListeners;
use TestBench\Laravel\Eloquent\ChangeCollector;
use TestBench\Laravel\Eloquent\EloquentPreviewProvider;
use TestBench\Laravel\Http\AllowPreview;
use TestBench\Laravel\Http\PreviewMiddleware;
use TestBench\Laravel\Http\WorkbenchController;

/**
 * Registers Test Bench. The package installs the preview transport as global middleware, but
 * mounts the workbench routes and accepts previews only when enabled in an allow-listed environment.
 */
final class TestBenchServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__ . '/../config/testbench.php', 'testbench');
        $this->app->singleton(TestBenchManager::class);
        $this->app->scoped(Recorder::class);
        $this->app->scoped(ChangeCollector::class);
        $this->app->bind(EloquentPreviewProvider::class, fn ($app) => new EloquentPreviewProvider(
            $app->make('db'),
            $app->make(ChangeCollector::class),
            (array) $app['config']->get('testbench.connections', [null]),
            $app['config']->get('testbench.database_label'),
        ));
    }

    public function boot(): void
    {
        $this->publishes([__DIR__ . '/../config/testbench.php' => $this->app->configPath('testbench.php')], 'testbench-config');

        $this->app->make('router')->aliasMiddleware('testbench.preview', AllowPreview::class);
        $this->registerMacros();
        (new CaptureListeners($this->app))->register($this->app->make('events'));

        $kernel = $this->app->make(Kernel::class);
        if (method_exists($kernel, 'prependMiddleware')) {
            $kernel->prependMiddleware(PreviewMiddleware::class);
        }

        if ($this->app->make(TestBenchManager::class)->enabled() && !$this->app->routesAreCached()) {
            $this->mountRoutes();
        }
    }

    /** Adds `->testbenchPreview()` to routes and route groups. */
    private function registerMacros(): void
    {
        RouteDefinition::macro('testbenchPreview', function () {
            /** @var RouteDefinition $this */
            return $this->middleware(AllowPreview::class);
        });
        RouteRegistrar::macro('testbenchPreview', function () {
            /** @var RouteRegistrar $this */
            return $this->middleware(AllowPreview::class);
        });
    }

    private function mountRoutes(): void
    {
        $router = $this->app->make(Router::class);
        $middleware = $this->app['config']->get('testbench.middleware');
        $middleware ??= $router->hasMiddlewareGroup('web') ? ['web'] : [];
        if (($ability = $this->app['config']->get('testbench.authorize')) !== null) {
            $middleware[] = 'can:' . $ability;
        }

        Route::middleware($middleware)->prefix('bench')->group(function (): void {
            Route::get('/', [WorkbenchController::class, 'index']);
            Route::get('signin.html', [WorkbenchController::class, 'index']);
            Route::get('_api/capabilities', [WorkbenchController::class, 'capabilities']);
            Route::get('_api/traces/{id}', [WorkbenchController::class, 'trace'])->where('id', '[0-9a-fA-F-]{32,36}');
            Route::get('{asset}', [WorkbenchController::class, 'asset'])->where('asset', '.*');
        });
    }
}
