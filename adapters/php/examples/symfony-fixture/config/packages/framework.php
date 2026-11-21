<?php

use Symfony\Component\DependencyInjection\Loader\Configurator\ContainerConfigurator;

return static function (ContainerConfigurator $container): void {
    $container->extension('framework', [
        'secret' => 'fixture-secret',
        'http_method_override' => false,
        'handle_all_throwables' => true,
        'router' => ['utf8' => true],
        'mailer' => ['dsn' => 'null://null'],
    ]);
};
