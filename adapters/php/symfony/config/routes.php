<?php

declare(strict_types=1);

use Symfony\Component\Routing\Loader\Configurator\RoutingConfigurator;
use TestBench\Symfony\Controller\WorkbenchController;

/**
 * Workbench routes. Import them from `config/routes/testbench.yaml`:
 *
 *     testbench:
 *         resource: '@TestBenchBundle/config/routes.php'
 *
 * The routes always exist, but each action answers 404 unless `testbench.enabled` is true for the
 * current environment, so route caching never needs to know the environment.
 */
return static function (RoutingConfigurator $routes): void {
    // One route serves `/bench` (redirects to `/bench/`) and `/bench/` (the UI), so Symfony's own
    // trailing-slash redirect, which uses absolute URLs, never takes over.
    $routes->add('testbench_index', '/bench{slash}')
        ->controller([WorkbenchController::class, 'index'])->methods(['GET'])
        ->defaults(['slash' => ''])->requirements(['slash' => '/?']);
    $routes->add('testbench_signin', '/bench/signin.html')->controller([WorkbenchController::class, 'index'])->methods(['GET']);
    $routes->add('testbench_capabilities', '/bench/_api/capabilities')->controller([WorkbenchController::class, 'capabilities'])->methods(['GET']);
    $routes->add('testbench_trace', '/bench/_api/traces/{id}')
        ->controller([WorkbenchController::class, 'trace'])->methods(['GET'])->requirements(['id' => '[0-9a-fA-F-]{32,36}']);
    $routes->add('testbench_asset', '/bench/{asset}')
        ->controller([WorkbenchController::class, 'asset'])->methods(['GET'])->requirements(['asset' => '.+']);
};
