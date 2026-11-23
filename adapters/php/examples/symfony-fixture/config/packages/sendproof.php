<?php

use Fixture\Security\FixtureIdentity;
use Fixture\Support\FailingRollbackProvider;
use Symfony\Component\DependencyInjection\Loader\Configurator\ContainerConfigurator;

return static function (ContainerConfigurator $container): void {
    $scenario = getenv('BENCH_SCENARIO') ?: 'standard';
    $container->extension('sendproof', [
        'enabled' => true,
        'environments' => ['dev'],
        'api_name' => 'Sendproof Conformance',
        'journeys' => [dirname(__DIR__, 3) . '/journeys/conformance.arazzo.json'],
        'identity' => FixtureIdentity::class,
        'provider' => match ($scenario) {
            'no-provider' => null,
            'rollback-failure' => FailingRollbackProvider::class,
            default => 'doctrine',
        },
        'auth_providers' => [
            ['label' => 'Fixture password', 'kind' => 'cookie', 'url' => '/auth/sign-in'],
            ['label' => 'Fixture personas', 'kind' => 'personas', 'url' => '/auth/personas'],
        ],
        // A data store is hooked only when the runner supplies its namespace, so the standard scenarios run as before.
        'data_stores' => array_filter([
            'mongodb' => getenv('BENCH_MONGODB_URL') ? ['clients' => ['app.mongo'], 'name' => 'catalog'] : null,
            'redis' => getenv('BENCH_REDIS_URL') ? ['clients' => ['app.redis'], 'name' => 'cache'] : null,
            'dynamodb' => getenv('BENCH_DYNAMODB_URL') ? ['clients' => ['app.dynamo'], 'name' => 'orders'] : null,
            'opensearch' => getenv('BENCH_OPENSEARCH_URL') ? ['clients' => ['app.opensearch'], 'name' => 'articles'] : null,
        ]),
        'trace' => ['ttl' => (int) (getenv('SENDPROOF_TRACE_TTL') ?: 5), 'path' => getenv('FIXTURE_DIR') . '/traces'],
    ]);
};
