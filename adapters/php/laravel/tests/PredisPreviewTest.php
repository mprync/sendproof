<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Tests;

/** The Redis hook on Predis. */
final class PredisPreviewTest extends RedisPreviewBase
{
    protected function redisClient(): string
    {
        return 'predis';
    }
}
