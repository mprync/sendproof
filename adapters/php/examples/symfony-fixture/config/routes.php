<?php

use Symfony\Component\Routing\Loader\Configurator\RoutingConfigurator;

return static function (RoutingConfigurator $routes): void {
    $routes->import('../src/Controller/', 'attribute');
    foreach (['BENCH_MONGODB_URL' => 'MongoController', 'BENCH_REDIS_URL' => 'RedisController', 'BENCH_DYNAMODB_URL' => 'DynamoController', 'BENCH_OPENSEARCH_URL' => 'OpenSearchController'] as $variable => $controller) {
        if (getenv($variable)) {
            $routes->import('../src/Store/' . $controller . '.php', 'attribute');
        }
    }
    if (getenv('BENCH_REDIS_URL') || getenv('BENCH_DYNAMODB_URL') || getenv('BENCH_OPENSEARCH_URL')) {
        $routes->import('../src/Store/RememberController.php', 'attribute');
    }
    $routes->import('@SendproofBundle/config/routes.php');
};
