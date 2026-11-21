<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use PHPUnit\Framework\TestCase;
use Sendproof\Core\Trace\FileTraceStore;
use Sendproof\Core\Trace\TraceOwner;

final class TraceStoreTest extends TestCase
{
    private string $directory;
    private float $now = 1000.0;

    protected function setUp(): void
    {
        $this->directory = sys_get_temp_dir() . '/sendproof-core-' . bin2hex(random_bytes(4));
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

    public function testTraceFilesAndTheDirectoryArePrivate(): void
    {
        $id = $this->store()->put('alice', ['x' => 1]);

        $this->assertSame(0700, fileperms($this->directory) & 0777);
        $this->assertSame(0600, fileperms($this->directory . '/' . $id . '.json') & 0777);
    }

    public function testAnExistingSharedDirectoryIsTightenedBeforeUse(): void
    {
        mkdir($this->directory, 0777);
        chmod($this->directory, 0777);

        $this->store()->put('alice', ['x' => 1]);

        clearstatcache();
        $this->assertSame(0700, fileperms($this->directory) & 0777);
    }

    public function testASymlinkedDirectoryIsRefused(): void
    {
        $target = $this->directory . '-target';
        mkdir($target, 0700);
        symlink($target, $this->directory);
        try {
            $this->expectException(\RuntimeException::class);
            $this->store()->put('alice', ['x' => 1]);
        } finally {
            unlink($this->directory);
            rmdir($target);
        }
    }

    public function testStaleTemporaryFilesAreRemoved(): void
    {
        $store = $this->store(5);
        $store->put('alice', ['x' => 1]);
        $orphan = $this->directory . '/' . str_repeat('a', 32) . '.json.dead.tmp';
        file_put_contents($orphan, '{}');
        touch($orphan, time() - 60);

        $store->put('alice', ['x' => 2]);

        $this->assertFileDoesNotExist($orphan);
    }

    public function testOwnerKeysRequireAStableSubject(): void
    {
        $this->assertNull(TraceOwner::key('web', null, ''));
        $this->assertNull(TraceOwner::key('web', '', ''));
        $this->assertNotSame(TraceOwner::key('web', '1', ''), TraceOwner::key('web', '1', '/tenant'));
        $this->assertNotSame(TraceOwner::key('web', '1', ''), TraceOwner::key('api', '1', ''));
    }
}
