<?php

declare(strict_types=1);

namespace TestBench\Core\Capture;

use TestBench\Core\Limits;

/**
 * Collects logs, effects and SQL for one request while a preview or observed send is running.
 *
 * Hosts call `tryRecord*` before an external effect. In a preview the method returns true and
 * the host must skip the effect. In an observed send it records the effect as delivered and
 * returns false, so the host proceeds. Outside both modes nothing is recorded.
 */
final class Recorder
{
    private bool $active = false;
    private bool $rollback = false;
    private bool $logsTruncated = false;
    private bool $effectsTruncated = false;
    private int $logSize = 0;
    private int $effectSize = 0;
    private int $requestStart = 0;
    private float $dbMs = 0.0;
    private int $queries = 0;
    private float $serializeMs = 0.0;
    /** @var list<array<string,mixed>> */
    private array $effects = [];
    /** @var list<array<string,mixed>> */
    private array $logs = [];

    /** True while a rollback-only preview is running in this request. */
    public function isPreview(): bool
    {
        return $this->active && $this->rollback;
    }

    /** True while either a preview or an observed send is capturing. */
    public function isCapturing(): bool
    {
        return $this->active;
    }

    public function begin(bool $rollback, ?int $requestStart = null): void
    {
        $this->reset();
        $this->requestStart = $requestStart ?? hrtime(true);
        $this->rollback = $rollback;
        $this->active = true;
    }

    /** Records an effect and returns true when the host must suppress its delivery. */
    public function tryRecordEffect(string $kind, string $description, mixed $data = null): bool
    {
        if (!$this->active) {
            return false;
        }
        if (count($this->effects) === Limits::EFFECTS || $this->effectSize >= Limits::LOG_BUDGET) {
            $this->effectsTruncated = true;
            return $this->rollback;
        }

        $started = hrtime(true);
        $truncated = false;
        $captured = $data === null ? null : Limits::payload($data, $truncated);
        $this->serializeMs += (hrtime(true) - $started) / 1e6;
        $capturedKind = Limits::clip($kind, Limits::NAME);
        $capturedDescription = Limits::clip($description);
        $this->effectSize += strlen($capturedKind) + strlen($capturedDescription) + Limits::size($captured);
        $this->effectsTruncated = $this->effectsTruncated || $truncated || $capturedKind !== $kind || $capturedDescription !== $description;
        if ($this->effectSize <= Limits::LOG_BUDGET) {
            $effect = ['kind' => $capturedKind, 'description' => $capturedDescription, 'data' => $captured];
            if (!$this->rollback) {
                $effect['delivered'] = true;
            }
            $this->effects[] = $effect;
        } else {
            $this->effectsTruncated = true;
        }

        return $this->rollback;
    }

    /** @param iterable<string> $to @param iterable<string> $cc */
    public function tryRecordEmail(string $description, string $from, iterable $to, iterable $cc, string $subject, string $text, ?string $html = null): bool
    {
        return $this->tryRecordEffect('email', $description, [
            'from' => $from, 'to' => [...$to], 'cc' => [...$cc], 'subject' => $subject, 'text' => $text, 'html' => $html,
        ]);
    }

    public function tryRecordHttp(string $description, string $method, string $url, ?int $status = null, mixed $body = null): bool
    {
        return $this->tryRecordEffect('http', $description, ['method' => $method, 'url' => $url, 'status' => $status, 'body' => $body]);
    }

    public function tryRecordJob(string $description, string $name, mixed $arguments, ?string $queue = null, ?\DateTimeInterface $runAt = null): bool
    {
        return $this->tryRecordEffect('job', $description, ['name' => $name, 'arguments' => $arguments, 'queue' => $queue, 'runAt' => $runAt?->format(\DateTimeInterface::ATOM)]);
    }

    public function tryRecordMessage(string $description, string $topic, mixed $payload, ?string $key = null): bool
    {
        return $this->tryRecordEffect('message', $description, ['topic' => $topic, 'payload' => $payload, 'key' => $key]);
    }

    /** Records a simple log entry and reports whether capture is active. */
    public function tryRecordLog(string $level, string $message): bool
    {
        if (!$this->active) {
            return false;
        }
        $this->log($level, $message);

        return true;
    }

    /**
     * Records a structured log entry.
     *
     * @param array<string,mixed> $properties
     * @param array{id:int,name?:string}|null $eventId
     * @param array{type:string,message:string}|null $exception
     */
    public function log(string $level, string $message, ?string $category = null, array $properties = [], ?array $eventId = null, ?array $exception = null): void
    {
        if (!$this->active || !$this->hasLogRoom()) {
            return;
        }

        $entry = ['level' => $this->clip($level, Limits::NAME), 'message' => $this->clip($message)];
        if ($category !== null) {
            $entry['category'] = $this->clip($category, Limits::NAME);
        }
        if ($eventId !== null) {
            $entry['eventId'] = $eventId;
        }
        $entry['offsetMs'] = $this->offsetMs();
        $captured = [];
        foreach ($properties as $name => $value) {
            if (count($captured) === Limits::PROPERTIES) {
                $this->logsTruncated = true;
                break;
            }
            $text = is_scalar($value) || $value === null || $value instanceof \Stringable
                ? (string) $value
                : (json_encode($value, JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE) ?: '');
            $captured[$this->clip((string) $name, Limits::NAME)] = $this->clip($text);
        }
        if ($captured !== []) {
            $entry['properties'] = $captured;
        }
        if ($exception !== null) {
            $entry['exception'] = ['type' => $this->clip($exception['type'], Limits::NAME), 'message' => $this->clip($exception['message'])];
        }
        $this->add($entry);
    }

    /**
     * Records an executed SQL statement and updates the database timing.
     *
     * @param array{text:string,parameters:list<array<string,mixed>>,rowsAffected?:int} $sql
     */
    public function recordSql(float $durationMs, array $sql, bool $truncated = false, ?string $category = null): void
    {
        if (!$this->active) {
            return;
        }
        $this->dbMs += $durationMs;
        $this->queries = min(PHP_INT_MAX, $this->queries + 1);
        if (!$this->hasLogRoom()) {
            return;
        }

        $this->logsTruncated = $this->logsTruncated || $truncated;
        $entry = ['level' => 'Sql', 'message' => $sql['text']];
        if ($category !== null) {
            $entry['category'] = $category;
        }
        $entry['offsetMs'] = max(0.0, $this->offsetMs() - $durationMs);
        $entry['elapsedMs'] = $durationMs;
        $entry['sql'] = $sql;
        $this->add($entry);
    }

    /** Adds time spent serialising the capture, reported as the `serialize` metric. */
    public function addSerializeMs(float $milliseconds): void
    {
        $this->serializeMs += $milliseconds;
    }

    /** @return array{0:float,1:int,2:float} database ms, query count, serialize ms */
    public function counters(): array
    {
        return [$this->dbMs, $this->queries, $this->serializeMs];
    }

    /**
     * Stops capturing and hands over what was recorded.
     *
     * @return array{effects:list<array<string,mixed>>,logs:list<array<string,mixed>>,logsTruncated:bool,effectsTruncated:bool}
     */
    public function finish(): array
    {
        $this->active = false;
        $snapshot = [
            'effects' => $this->effects,
            'logs' => $this->logs,
            'logsTruncated' => $this->logsTruncated,
            'effectsTruncated' => $this->effectsTruncated,
        ];
        $this->effects = [];
        $this->logs = [];

        return $snapshot;
    }

    private function reset(): void
    {
        $this->effects = [];
        $this->logs = [];
        $this->logsTruncated = $this->effectsTruncated = false;
        $this->logSize = $this->effectSize = $this->queries = 0;
        $this->dbMs = $this->serializeMs = 0.0;
    }

    private function offsetMs(): float
    {
        return round((hrtime(true) - $this->requestStart) / 1e6, 3);
    }

    private function clip(string $value, int $maximum = Limits::TEXT): string
    {
        $clipped = Limits::clip($value, $maximum);
        $this->logsTruncated = $this->logsTruncated || $clipped !== $value;

        return $clipped;
    }

    private function hasLogRoom(): bool
    {
        $room = count($this->logs) < Limits::LOGS && $this->logSize < Limits::LOG_BUDGET;
        $this->logsTruncated = $this->logsTruncated || !$room;

        return $room;
    }

    /** @param array<string,mixed> $entry */
    private function add(array $entry): void
    {
        $size = Limits::size($entry);
        if ($this->logSize + $size <= Limits::LOG_BUDGET) {
            $this->logs[] = $entry;
            $this->logSize += $size;
        } else {
            $this->logsTruncated = true;
        }
    }
}
