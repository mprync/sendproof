<?php

declare(strict_types=1);

namespace TestBench\Core\Trace;

/**
 * File-backed trace store that works across PHP-FPM workers and `php -S` workers.
 *
 * Each trace is a JSON file inside a private directory, written atomically. Entries expire after
 * `$ttlSeconds`; an owner keeps at most `$perOwner` traces and the directory at most `$total`.
 * Older entries are evicted first. Tests can shorten the TTL or inject a clock.
 */
final class FileTraceStore implements TraceStore
{
    /** @var \Closure(): float */
    private readonly \Closure $clock;

    public function __construct(
        private readonly string $directory,
        private readonly int $ttlSeconds = 300,
        private readonly int $perOwner = 8,
        private readonly int $total = 32,
        ?\Closure $clock = null,
    ) {
        $this->clock = $clock ?? static fn (): float => microtime(true);
    }

    public function put(string $ownerKey, array $trace): string
    {
        return $this->locked(function () use ($ownerKey, $trace): string {
            $entries = $this->entries();
            $mine = array_values(array_filter($entries, static fn (array $entry): bool => $entry['owner'] === $ownerKey));
            while (count($mine) >= $this->perOwner) {
                $oldest = array_shift($mine);
                @unlink($oldest['file']);
                $entries = array_values(array_filter($entries, static fn (array $entry): bool => $entry['file'] !== $oldest['file']));
            }
            while (count($entries) >= $this->total) {
                $oldest = array_shift($entries);
                @unlink($oldest['file']);
            }

            $id = bin2hex(random_bytes(16));
            $file = $this->directory . DIRECTORY_SEPARATOR . $id . '.json';
            $temporary = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
            file_put_contents($temporary, json_encode(['owner' => $ownerKey, 'created' => ($this->clock)(), 'trace' => $trace], JSON_THROW_ON_ERROR | JSON_PARTIAL_OUTPUT_ON_ERROR));
            chmod($temporary, 0600);
            rename($temporary, $file);

            return $id;
        });
    }

    public function get(string $id, string $ownerKey): ?array
    {
        $normalized = strtolower(str_replace('-', '', $id));
        if (!preg_match('/^[0-9a-f]{32}$/', $normalized)) {
            return null;
        }

        return $this->locked(function () use ($normalized, $ownerKey): ?array {
            $file = $this->directory . DIRECTORY_SEPARATOR . $normalized . '.json';
            $entry = $this->read($file);
            if ($entry === null) {
                return null;
            }
            if (($this->clock)() - $entry['created'] >= $this->ttlSeconds) {
                @unlink($file);
                return null;
            }

            return hash_equals($entry['owner'], $ownerKey) ? $entry['trace'] : null;
        });
    }

    /**
     * Live entries oldest first. Expired files are deleted on the way.
     *
     * @return list<array{file:string,owner:string,created:float}>
     */
    private function entries(): array
    {
        $entries = [];
        foreach (glob($this->directory . DIRECTORY_SEPARATOR . '*.json') ?: [] as $file) {
            $entry = $this->read($file);
            if ($entry === null || ($this->clock)() - $entry['created'] >= $this->ttlSeconds) {
                @unlink($file);
                continue;
            }
            $entries[] = ['file' => $file, 'owner' => $entry['owner'], 'created' => $entry['created']];
        }
        usort($entries, static fn (array $a, array $b): int => $a['created'] <=> $b['created']);

        return $entries;
    }

    /** @return array{owner:string,created:float,trace:array<string,mixed>}|null */
    private function read(string $file): ?array
    {
        $json = @file_get_contents($file);
        $entry = $json === false ? null : json_decode($json, true);

        return is_array($entry) && isset($entry['owner'], $entry['created'], $entry['trace']) ? $entry : null;
    }

    /** @template T @param callable(): T $callback @return T */
    private function locked(callable $callback): mixed
    {
        if (!is_dir($this->directory) && !@mkdir($this->directory, 0700, true) && !is_dir($this->directory)) {
            throw new \RuntimeException("Cannot create the trace directory {$this->directory}.");
        }
        $handle = fopen($this->directory . DIRECTORY_SEPARATOR . '.lock', 'c');
        if ($handle === false || !flock($handle, LOCK_EX)) {
            throw new \RuntimeException('Cannot lock the trace directory.');
        }
        try {
            return $callback();
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }
}
