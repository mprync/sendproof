<?php

declare(strict_types=1);

namespace Fixture;

use Symfony\Bundle\FrameworkBundle\Kernel\MicroKernelTrait;
use Symfony\Component\HttpKernel\Kernel as BaseKernel;

/** Kernel whose cache and logs live in the per-process fixture directory. */
final class Kernel extends BaseKernel
{
    use MicroKernelTrait;

    public function getProjectDir(): string
    {
        return dirname(__DIR__);
    }

    public function getCacheDir(): string
    {
        return $this->fixtureDir() . '/var/cache/' . $this->environment;
    }

    public function getLogDir(): string
    {
        return $this->fixtureDir() . '/var/log';
    }

    private function fixtureDir(): string
    {
        return (string) (getenv('FIXTURE_DIR') ?: sys_get_temp_dir() . '/sendproof-symfony-fixture');
    }
}
