<?php

declare(strict_types=1);

namespace TestBench\Core\Tests;

use PHPUnit\Framework\TestCase;
use TestBench\Core\Trace\FileTraceStore;
use TestBench\Core\Trace\TraceOwner;

final class TraceStoreTest extends TestCase
{
    private string $directory;
    private float $now = 1000.0;

    protected function setUp(): void
    {
        $this->directory = sys_get_temp_dir() . '/testbench-core-' . bin2hex(random_bytes(4));
    }

    protected function tearDown(): void
    {
        foreach (glob($this->directory . '/{,.}*', GLOB_BRACE) ?: [] as $file) {
            is_file($file) && unlink($file);
        }
        is_dir($this->directory) && rmdir($this->directory);
    }

    private function store(int $ttl = 5, int $perOwner = 2, int $total = 3): FileTraceStore
    {
        return new FileTraceStore($this->directory, $ttl, $perOwner, $total, fn (): float => $this->now);
    }

    public function testOnlyTheOwnerCanReadATrace(): void
    {
        $store = $this->store();
        $id = $store->put('alice', ['logs' => []]);

        $this->assertSame(['logs' => []], $store->get($id, 'alice'));
        $this->assertNull($store->get($id, 'bob'));
        $this->assertNull($store->get('not-an-id', 'alice'));
    }

    public function testTracesExpireAfterTheTtl(): void
    {
        $store = $this->store(5);
        $id = $store->put('alice', ['x' => 1]);

        $this->now += 4.9;
        $this->assertNotNull($store->get($id, 'alice'));
        $this->now += 0.2;
        $this->assertNull($store->get($id, 'alice'));
    }

    public function testOldestTracesAreEvictedPerOwnerAndInTotal(): void
    {
        $store = $this->store(300, 2, 3);
        $first = $store->put('alice', ['n' => 1]);
        $this->now += 1;
        $store->put('alice', ['n' => 2]);
        $this->now += 1;
        $store->put('alice', ['n' => 3]);

        $this->assertNull($store->get($first, 'alice'));

        $this->now += 1;
        $store->put('bob', ['n' => 4]);
        $this->now += 1;
        $other = $store->put('carol', ['n' => 5]);

        $this->assertCount(3, glob($this->directory . '/*.json'));
        $this->assertNotNull($store->get($other, 'carol'));
    }

    public function testOwnerKeysRequireAStableSubject(): void
    {
        $this->assertNull(TraceOwner::key('web', null, ''));
        $this->assertNull(TraceOwner::key('web', '', ''));
        $this->assertNotSame(TraceOwner::key('web', '1', ''), TraceOwner::key('web', '1', '/tenant'));
        $this->assertNotSame(TraceOwner::key('web', '1', ''), TraceOwner::key('api', '1', ''));
    }
}
