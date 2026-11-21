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
        'trace' => ['ttl' => (int) (getenv('SENDPROOF_TRACE_TTL') ?: 5), 'path' => getenv('FIXTURE_DIR') . '/traces'],
    ]);
};
