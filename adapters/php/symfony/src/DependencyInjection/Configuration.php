<?php

declare(strict_types=1);

namespace Sendproof\Symfony\DependencyInjection;

use Symfony\Component\Config\Definition\Builder\TreeBuilder;
use Symfony\Component\Config\Definition\ConfigurationInterface;

/** The `sendproof:` configuration tree. Everything is off unless `enabled` is true. */
final class Configuration implements ConfigurationInterface
{
    public function getConfigTreeBuilder(): TreeBuilder
    {
        $tree = new TreeBuilder('sendproof');
        $root = $tree->getRootNode();
        $root
            ->children()
                ->booleanNode('enabled')->defaultFalse()
                    ->info('Master switch. Nothing is served and previews are refused unless true.')->end()
                ->arrayNode('environments')->scalarPrototype()->end()->defaultValue(['dev'])
                    ->info('Kernel environments where the workbench may run. Production is not listed by default.')->end()
                ->scalarNode('api_name')->defaultNull()->end()
                ->scalarNode('openapi_url')->defaultValue('/openapi/v1.json')
                    ->info('Application-relative URL of the OpenAPI document.')->end()
                ->arrayNode('documents')
                    ->arrayPrototype()->children()
                        ->scalarNode('name')->isRequired()->end()
                        ->scalarNode('url')->isRequired()->end()
                    ->end()->end()
                ->end()
                ->arrayNode('field_modules')->scalarPrototype()->end()->end()
                ->arrayNode('auth_providers')
                    ->info('Sign-in methods shown by the workbench.')
                    ->arrayPrototype()->children()
                        ->scalarNode('label')->isRequired()->end()
                        ->scalarNode('kind')->isRequired()->end()
                        ->scalarNode('url')->defaultNull()->end()
                    ->end()->end()
                ->end()
                ->scalarNode('authorize')->defaultNull()
                    ->info('Security attribute (such as ROLE_ADMIN) required to use the workbench, previews and traces.')->end()
                ->scalarNode('identity')->defaultNull()
                    ->info('Service id of a Sendproof\Symfony\Identity\IdentityResolver. Defaults to the user identifier.')->end()
                ->scalarNode('provider')->defaultValue('doctrine')
                    ->info('"doctrine", null to disable previews, or the id of a PreviewProvider service.')->end()
                ->arrayNode('connections')->scalarPrototype()->end()->defaultValue(['default'])
                    ->info('Doctrine connections enrolled in a preview. Unlisted connections are NOT rolled back.')->end()
                ->scalarNode('database_label')->defaultNull()->end()
                ->booleanNode('include_sql_parameter_values')->defaultNull()
                    ->info('Show SQL parameter values. Null shows them in dev and test only.')->end()
                ->arrayNode('trace')->addDefaultsIfNotSet()->children()
                    ->integerNode('ttl')->defaultValue(300)->min(1)->info('Seconds an observed-send trace stays readable.')->end()
                    ->integerNode('per_owner')->defaultValue(8)->end()
                    ->integerNode('total')->defaultValue(32)->end()
                    ->scalarNode('path')->defaultNull()->info('Private directory for traces. Defaults to var/sendproof-traces.')->end()
                ->end()->end()
                ->scalarNode('ui_path')->defaultNull()->info('Directory of the embedded UI bundle. Defaults to the sendproof/core copy.')->end()
            ->end();

        return $tree;
    }
}
