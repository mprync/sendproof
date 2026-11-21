<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Tests;

/** The Redis hook on phpredis. */
final class PhpRedisPreviewTest extends RedisPreviewBase
{
    protected function redisClient(): string
    {
        return 'phpredis';
    }
}
