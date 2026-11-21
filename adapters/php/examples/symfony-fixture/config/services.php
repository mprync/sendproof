<?php

use Fixture\Support\FailingRollbackProvider;
use Symfony\Component\DependencyInjection\Loader\Configurator\ContainerConfigurator;
use Sendproof\Symfony\Doctrine\OrmChangeCollector;

use function Symfony\Component\DependencyInjection\Loader\Configurator\param;
use function Symfony\Component\DependencyInjection\Loader\Configurator\service;

return static function (ContainerConfigurator $container): void {
    $services = $container->services();
    $services->defaults()->autowire()->autoconfigure();
    $services->load('Fixture\\', '../src/')->exclude('../src/{Entity,Kernel.php,Support}');
    $services->set(FailingRollbackProvider::class)
        ->args([service('doctrine'), service(OrmChangeCollector::class), param('sendproof.connections'), null]);
};
