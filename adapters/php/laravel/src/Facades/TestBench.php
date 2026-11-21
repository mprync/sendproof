<?php

declare(strict_types=1);

namespace TestBench\Laravel\Facades;

use Closure;
use Illuminate\Support\Facades\Facade;
use TestBench\Laravel\TestBenchManager;

/**
 * Entry point for recording effects and customising identity and authorization.
 *
 * @method static bool tryRecordEffect(string $kind, string $description, mixed $data = null)
 * @method static bool tryRecordEmail(string $description, string $from, iterable $to, iterable $cc, string $subject, string $text, ?string $html = null)
 * @method static bool tryRecordHttp(string $description, string $method, string $url, ?int $status = null, mixed $body = null)
 * @method static bool tryRecordJob(string $description, string $name, mixed $arguments, ?string $queue = null, ?\DateTimeInterface $runAt = null)
 * @method static bool tryRecordMessage(string $description, string $topic, mixed $payload, ?string $key = null)
 * @method static bool isPreview()
 * @method static void identifyUsing(Closure $resolver)
 * @method static void authorizeUsing(Closure $authorizer)
 *
 * @see TestBenchManager
 */
final class TestBench extends Facade
{
    protected static function getFacadeAccessor(): string
    {
        return TestBenchManager::class;
    }
}
