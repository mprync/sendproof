<?php

use Fixture\Security\CookieAuthenticator;
use Symfony\Component\DependencyInjection\Loader\Configurator\ContainerConfigurator;

return static function (ContainerConfigurator $container): void {
    $container->extension('security', [
        'providers' => ['users' => ['memory' => ['users' => [
            'admin@example.test' => ['roles' => ['ROLE_ADMIN']],
            'viewer@example.test' => ['roles' => ['ROLE_USER']],
        ]]]],
        'role_hierarchy' => ['ROLE_ADMIN' => ['ROLE_USER']],
        'firewalls' => ['main' => [
            'stateless' => true,
            'provider' => 'users',
            'custom_authenticators' => [CookieAuthenticator::class],
            'entry_point' => CookieAuthenticator::class,
        ]],
        // Anonymous API callers receive 401, a viewer may only read, and only the admin may write.
        'access_control' => [
            ['path' => '^/auth/personas', 'roles' => 'ROLE_ADMIN'],
            ['path' => '^/items', 'methods' => ['GET'], 'roles' => 'ROLE_USER'],
            ['path' => '^/items', 'roles' => 'ROLE_ADMIN'],
        ],
    ]);
};
