<?php

declare(strict_types=1);

namespace TestBench\Symfony\DependencyInjection;

use Symfony\Component\Config\FileLocator;
use Symfony\Component\DependencyInjection\ContainerBuilder;
use Symfony\Component\DependencyInjection\Extension\Extension;
use Symfony\Component\DependencyInjection\Loader\PhpFileLoader;
use Symfony\Component\DependencyInjection\Reference;
use TestBench\Core\Contracts\PreviewProvider;
use TestBench\Symfony\Doctrine\DoctrinePreviewProvider;
use TestBench\Symfony\Identity\DefaultIdentityResolver;

/** Loads the bundle services and chooses the preview provider and identity resolver. */
final class TestBenchExtension extends Extension
{
    public function getAlias(): string
    {
        return 'testbench';
    }

    /** @param array<int,array<string,mixed>> $configs */
    public function load(array $configs, ContainerBuilder $container): void
    {
        $config = $this->processConfiguration(new Configuration(), $configs);
        $container->setParameter('testbench.settings', $config);
        $container->setParameter('testbench.connections', $config['connections']);
        $container->setParameter('testbench.database_label', $config['database_label']);
        $container->setParameter('testbench.sql_values', $config['include_sql_parameter_values']);

        (new PhpFileLoader($container, new FileLocator(__DIR__ . '/../../config')))->load('services.php');

        $provider = $config['provider'];
        if ($provider === 'doctrine') {
            $container->setAlias(PreviewProvider::class, DoctrinePreviewProvider::class);
        } elseif ($provider !== null) {
            $container->setAlias(PreviewProvider::class, (string) $provider);
        } else {
            $container->removeAlias(PreviewProvider::class);
        }

        $container->setAlias('testbench.identity', $config['identity'] ?? DefaultIdentityResolver::class);
        $container->getAlias('testbench.identity')->setPublic(false);
        $container->getDefinition('testbench.manager')->replaceArgument(5,$provider === null ? null : new Reference(PreviewProvider::class));
    }
}
