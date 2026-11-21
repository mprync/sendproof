<?php

use Symfony\Component\DependencyInjection\Loader\Configurator\ContainerConfigurator;

return static function (ContainerConfigurator $container): void {
    // A handler must exist for Monolog to run processors. The fixture discards the records itself.
    $container->extension('monolog', ['handlers' => ['discard' => ['type' => 'null']]]);
};
