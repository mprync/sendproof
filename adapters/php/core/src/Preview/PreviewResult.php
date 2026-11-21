<?php

declare(strict_types=1);

namespace TestBench\Core\Preview;

/** Either a confirmed preview envelope or a rejection the transport must send as a problem response. */
final class PreviewResult
{
    /**
     * @param array<string,mixed>|null $envelope
     * @param array<string,string> $headers
     */
    private function __construct(
        public readonly ?array $envelope,
        public readonly int $status,
        public readonly string $title,
        public readonly array $headers,
        public readonly ?string $timing,
    ) {
    }

    /** @param array<string,mixed> $envelope */
    public static function confirmed(array $envelope, string $timing): self
    {
        return new self($envelope, 200, '', [], $timing);
    }

    /** @param array<string,string> $headers */
    public static function rejected(int $status, string $title, array $headers = []): self
    {
        return new self(null, $status, $title, $headers, null);
    }

    public function isConfirmed(): bool
    {
        return $this->envelope !== null;
    }
}
