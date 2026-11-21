<?php

declare(strict_types=1);

namespace TestBench\Symfony;

use Symfony\Component\DependencyInjection\Extension\ExtensionInterface;
use Symfony\Component\HttpKernel\Bundle\Bundle;
use TestBench\Symfony\DependencyInjection\TestBenchExtension;

/**
 * Test Bench for Symfony: an in-app API workbench with rollback previews and observed sends.
 *
 * Register the bundle, set `testbench.enabled`, import the workbench routes, and mark
 * operations with {@see Attribute\AllowPreview}.
 */
final class TestBenchBundle extends Bundle
{
    public function getContainerExtension(): ?ExtensionInterface
    {
        // The extension alias is `testbench`, not the `test_bench` Symfony would derive from the class name.
        return $this->extension ??= new TestBenchExtension();
    }

    public function getPath(): string
    {
        return dirname(__DIR__);
    }
}
