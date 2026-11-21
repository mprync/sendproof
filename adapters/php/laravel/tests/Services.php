<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Tests;

use PHPUnit\Framework\Assert;

/**
 * Finds the data-store services of tests/conformance/compose.yml. A test that needs one is skipped,
 * with the command to start it, when the service doesn't answer a real request.
 */
final class Services
{
    /** @var array<string,bool> */
    private static array $answers = [];

    public static function mongodbUrl(): string
    {
        return getenv('BENCH_MONGODB_SERVER_URL') ?: 'mongodb://127.0.0.1:57017/?directConnection=true';
    }

    /** @return array{host:string,port:int,password:string} */
    public static function redis(): array
    {
        $parts = parse_url(getenv('BENCH_REDIS_SERVER_URL') ?: 'redis://:bench_redis_local@127.0.0.1:56379');

        return ['host' => $parts['host'] ?? '127.0.0.1', 'port' => $parts['port'] ?? 6379, 'password' => rawurldecode($parts['pass'] ?? '')];
    }

    public static function dynamodbUrl(): string
    {
        return getenv('BENCH_DYNAMODB_SERVER_URL') ?: 'http://127.0.0.1:58000';
    }

    /** Skips the running test unless `$store` (`mongodb`, `redis` or `dynamodb`) answers. */
    public static function need(string $store): void
    {
        self::$answers[$store] ??= match ($store) {
            'mongodb' => extension_loaded('mongodb') && self::mongodb(),
            'redis' => self::redisAnswers(),
            'dynamodb' => @file_get_contents(self::dynamodbUrl(), false, stream_context_create(['http' => ['timeout' => 2, 'ignore_errors' => true]])) !== false,
        };
        if (!self::$answers[$store]) {
            Assert::markTestSkipped("{$store} is not answering. Start it with: docker compose -f tests/conformance/compose.yml up -d --wait mongodb redis dynamodb");
        }
    }

    private static function mongodb(): bool
    {
        try {
            (new \MongoDB\Driver\Manager(self::mongodbUrl(), ['serverSelectionTimeoutMS' => 1500, 'connectTimeoutMS' => 1500]))
                ->executeCommand('admin', new \MongoDB\Driver\Command(['ping' => 1]));

            return true;
        } catch (\Throwable) {
            return false;
        }
    }

    private static function redisAnswers(): bool
    {
        $redis = self::redis();
        $socket = @stream_socket_client("tcp://{$redis['host']}:{$redis['port']}", $code, $message, 1.5);
        if ($socket === false) {
            return false;
        }
        stream_set_timeout($socket, 2);
        fwrite($socket, "*2\r\n\$4\r\nAUTH\r\n$" . strlen($redis['password']) . "\r\n{$redis['password']}\r\n*1\r\n\$4\r\nPING\r\n");
        $reply = (string) fread($socket, 64);
        fclose($socket);

        return str_contains($reply, 'PONG');
    }
}
