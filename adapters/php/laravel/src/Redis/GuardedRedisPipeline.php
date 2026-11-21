<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Redis;

use Sendproof\Core\Stores\CommandKind;
use Sendproof\Core\Stores\Redis\RedisHook;

/**
 * Wraps a phpredis pipeline or `MULTI` object so each command is classified as it is queued.
 *
 * A refused write throws inside the pipeline callback, before `exec()` is reached, so nothing of
 * the batch (and no `EXEC`) is written; Laravel discards a half-built transaction when its
 * callback throws. Calls that return the pipeline return this wrapper, so chaining keeps the guard.
 */
final class GuardedRedisPipeline
{
    public function __construct(private readonly object $inner, private readonly RedisHook $hook)
    {
    }

    /** @param list<mixed> $arguments */
    public function __call(string $method, array $arguments): mixed
    {
        $name = strtoupper($method);
        if ($name === 'EXEC' || $name === 'DISCARD' || $name === 'MULTI' || $name === 'PIPELINE') {
            $kind = CommandKind::Transaction;
        } else {
            [$name, $args] = self::redisCommand($method, $arguments);
            $kind = $this->hook->check($name, $args);
            $this->hook->record($name, $args, $kind, hrtime(true));
        }
        $result = $this->inner->{$method}(...$arguments);

        return $result === $this->inner ? $this : $result;
    }

    /**
     * The Redis command a Laravel/phpredis call sends: the upper-case method name, or for
     * `rawCommand` its first argument.
     *
     * @param list<mixed> $parameters
     * @return array{0:string,1:list<mixed>}
     */
    public static function redisCommand(string $method, array $parameters): array
    {
        $name = strtoupper($method);
        if ($name === 'RAWCOMMAND') {
            $name = strtoupper((string) ($parameters[0] ?? ''));
            $parameters = array_slice($parameters, 1);
        }

        return [$name, array_values($parameters)];
    }
}
