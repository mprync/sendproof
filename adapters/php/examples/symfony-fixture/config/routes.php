<?php

use Symfony\Component\Routing\Loader\Configurator\RoutingConfigurator;

return static function (RoutingConfigurator $routes): void {
    $routes->import('../src/Controller/', 'attribute');
    $routes->import('@TestBenchBundle/config/routes.php');
};
