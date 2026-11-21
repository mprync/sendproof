<?php

use Aws\DynamoDb\DynamoDbClient;

/**
 * Fixture overrides. Everything else comes from the package defaults.
 *
 * A data store is hooked only when the runner supplies its namespace (the BENCH_*_URL variables),
 * so the standard scenarios run exactly as before.
 */
return [
    'api_name' => 'Sendproof Conformance',
    'middleware' => [],
    'auth_providers' => [
        ['label' => 'Fixture password', 'kind' => 'cookie', 'url' => '/auth/sign-in'],
        ['label' => 'Fixture personas', 'kind' => 'personas', 'url' => '/auth/personas'],
    ],
    'data_stores' => array_filter([
        'mongodb' => getenv('BENCH_MONGODB_URL') ? ['connection' => 'mongodb', 'name' => 'catalog'] : null,
        'redis' => getenv('BENCH_REDIS_URL') ? ['name' => 'cache'] : null,
        'dynamodb' => getenv('BENCH_DYNAMODB_URL') ? ['clients' => [DynamoDbClient::class], 'name' => 'orders'] : null,
    ]),
];
