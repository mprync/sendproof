<?php

use Symfony\Component\DependencyInjection\Loader\Configurator\ContainerConfigurator;

return static function (ContainerConfigurator $container): void {
    $container->extension('doctrine', [
        'dbal' => ['connections' => ['default' => ['driver' => 'pdo_sqlite', 'path' => (string) getenv('DB_DATABASE')]]],
        'orm' => ['entity_managers' => ['default' => ['mappings' => ['Fixture' => [
            'type' => 'attribute', 'is_bundle' => false, 'dir' => '%kernel.project_dir%/src/Entity', 'prefix' => 'Fixture\\Entity',
        ]]]]],
    ]);
};
