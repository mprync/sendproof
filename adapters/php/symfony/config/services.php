<?php

declare(strict_types=1);

use Symfony\Component\DependencyInjection\Loader\Configurator\ContainerConfigurator;
use TestBench\Core\Capture\Recorder;
use TestBench\Symfony\Capture\LogProcessor;
use TestBench\Symfony\Capture\MailListener;
use TestBench\Symfony\Controller\WorkbenchController;
use TestBench\Symfony\Doctrine\CaptureMiddleware;
use TestBench\Symfony\Doctrine\DoctrinePreviewProvider;
use TestBench\Symfony\Doctrine\OrmChangeCollector;
use TestBench\Symfony\Http\ExecutionListener;
use TestBench\Symfony\Http\PreviewListener;
use TestBench\Symfony\Http\RouteCatalog;
use TestBench\Symfony\Identity\DefaultIdentityResolver;
use TestBench\Symfony\TestBenchManager;

use function Symfony\Component\DependencyInjection\Loader\Configurator\param;
use function Symfony\Component\DependencyInjection\Loader\Configurator\service;

return static function (ContainerConfigurator $container): void {
    $services = $container->services();

    $services->set(Recorder::class);
    $services->set(OrmChangeCollector::class)
        ->tag('doctrine.event_listener', ['event' => 'onFlush'])
        ->tag('doctrine.event_listener', ['event' => 'postFlush']);
    $services->set(DefaultIdentityResolver::class);

    $services->set(CaptureMiddleware::class)
        ->args([service(Recorder::class), param('testbench.sql_values'), param('kernel.environment')])
        ->tag('doctrine.middleware');

    $services->set(DoctrinePreviewProvider::class)
        ->args([service('doctrine'), service(OrmChangeCollector::class), param('testbench.connections'), param('testbench.database_label')]);

    $services->set('testbench.manager', TestBenchManager::class)
        ->args([
            param('testbench.settings'),
            param('kernel.environment'),
            param('kernel.project_dir'),
            service(Recorder::class),
            service('testbench.identity'),
            null, // PreviewProvider: replaced by the extension according to `testbench.provider`
            service('security.token_storage')->nullOnInvalid(),
            service('security.authorization_checker')->nullOnInvalid(),
        ]);
    $services->alias(TestBenchManager::class, 'testbench.manager');

    $services->set(RouteCatalog::class)->args([service('router')]);

    $services->set(PreviewListener::class)
        ->args([service('http_kernel'), service('testbench.manager'), service(RouteCatalog::class), service('security.token_storage')->nullOnInvalid(), service('logger')->nullOnInvalid()])
        ->tag('kernel.event_listener', ['event' => 'kernel.request', 'method' => 'onRequest', 'priority' => 4096]);

    $services->set(ExecutionListener::class)
        ->args([service('testbench.manager')])
        ->tag('kernel.event_listener', ['event' => 'kernel.controller', 'method' => 'onController', 'priority' => -4096])
        ->tag('kernel.event_listener', ['event' => 'kernel.exception', 'method' => 'onException', 'priority' => 4096])
        ->tag('kernel.event_listener', ['event' => 'kernel.response', 'method' => 'onResponse', 'priority' => 4096]);

    $services->set(WorkbenchController::class)
        ->args([service('testbench.manager'), service(RouteCatalog::class)])
        ->public()
        ->tag('controller.service_arguments');

    if (class_exists(\Monolog\LogRecord::class)) {
        $services->set(LogProcessor::class)->args([service(Recorder::class)])->tag('monolog.processor');
    }
    if (class_exists(\Symfony\Component\Mailer\Event\MessageEvent::class)) {
        $services->set(MailListener::class)
            ->args([service(Recorder::class)])
            ->tag('kernel.event_listener', ['event' => \Symfony\Component\Mailer\Event\MessageEvent::class, 'method' => 'onMessage', 'priority' => 4096]);
    }
};
