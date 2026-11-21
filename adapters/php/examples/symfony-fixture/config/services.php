<?php

use Aws\DynamoDb\DynamoDbClient;
use Doctrine\ORM\EntityManagerInterface;
use Fixture\Store\DynamoController;
use Fixture\Store\MongoController;
use Fixture\Store\RedisController;
use Fixture\Store\RememberController;
use Fixture\Support\FailingRollbackProvider;
use MongoDB\Client as MongoClient;
use Predis\Client as PredisClient;
use Symfony\Component\DependencyInjection\Loader\Configurator\ContainerConfigurator;
use Sendproof\Symfony\Doctrine\OrmChangeCollector;

use function Symfony\Component\DependencyInjection\Loader\Configurator\param;
use function Symfony\Component\DependencyInjection\Loader\Configurator\service;

return static function (ContainerConfigurator $container): void {
    $services = $container->services();
    $services->defaults()->autowire()->autoconfigure();
    $services->load('Fixture\\', '../src/')->exclude('../src/{Entity,Kernel.php,Support,Store}');
    $services->set(FailingRollbackProvider::class)
        ->args([service('doctrine'), service(OrmChangeCollector::class), param('sendproof.connections'), null]);

    // The data-store clients and routes exist only when the runner supplies their namespace.
    if ($url = getenv('BENCH_MONGODB_URL')) {
        $services->set('app.mongo', MongoClient::class)->args([$url])->public();
        $services->alias(MongoClient::class, 'app.mongo');
        $services->set(MongoController::class)->public()->tag('controller.service_arguments');
    }
    if ($url = getenv('BENCH_REDIS_URL')) {
        $parts = parse_url($url);
        $services->set('app.redis', PredisClient::class)->args([[
            'scheme' => 'tcp', 'host' => $parts['host'] ?? '127.0.0.1', 'port' => $parts['port'] ?? 6379,
            'password' => isset($parts['pass']) ? rawurldecode($parts['pass']) : null,
        ]])->public();
        $services->alias(PredisClient::class, 'app.redis');
        $services->set(RedisController::class)->public()->tag('controller.service_arguments');
    }
    if ($url = getenv('BENCH_DYNAMODB_URL')) {
        $services->set('app.dynamo', DynamoDbClient::class)->args([[
            'region' => getenv('AWS_REGION') ?: 'us-east-1', 'version' => 'latest', 'endpoint' => $url,
            'credentials' => ['key' => getenv('AWS_ACCESS_KEY_ID'), 'secret' => getenv('AWS_SECRET_ACCESS_KEY')],
        ]])->public();
        $services->alias(DynamoDbClient::class, 'app.dynamo');
        $services->set(DynamoController::class)->public()->tag('controller.service_arguments');
    }
    if (getenv('BENCH_REDIS_URL') || getenv('BENCH_DYNAMODB_URL')) {
        $services->set(RememberController::class)->public()->tag('controller.service_arguments')->args([
            service(EntityManagerInterface::class),
            service('app.redis')->nullOnInvalid(),
            service('app.dynamo')->nullOnInvalid(),
        ]);
    }
};
