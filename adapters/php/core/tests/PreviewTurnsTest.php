<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use PHPUnit\Framework\TestCase;
use Sendproof\Core\Preview\PreviewTurns;

/**
 * MySQL Previews take turns (docs/bindings/databases.md): InnoDB deadlocks three concurrent
 * Previews that insert one new key. PHP serves requests in separate processes, so the turn is a
 * file lock that has to hold across processes.
 */
final class PreviewTurnsTest extends TestCase
{
    private string $directory;

    protected function setUp(): void
    {
        $this->directory = sys_get_temp_dir() . '/sendproof-turns-test-' . bin2hex(random_bytes(4));
        mkdir($this->directory);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->directory . '/*') ?: [] as $file) {
            unlink($file);
        }
        rmdir($this->directory);
    }

    /** @return resource A child process that takes the turn, says so, holds it for `$millis` and exits. */
    private function holder(string $database, int $millis)
    {
        $autoload = realpath(__DIR__ . '/../vendor/autoload.php');
        $code = sprintf('require %s; $t = Sendproof\Core\Preview\PreviewTurns::take(%s, 5, %s); echo "held\n"; usleep(%d);', var_export($autoload, true), var_export($database, true), var_export($this->directory, true), $millis * 1000);
        $process = proc_open([PHP_BINARY, '-r', $code], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $this->assertIsResource($process);
        $this->assertSame("held\n", fgets($pipes[1]), 'The child process took its turn.');

        return $process;
    }

    public function testAPreviewWaitsForTheTurnAnotherProcessHolds(): void
    {
        $process = $this->holder('db-a', 700);
        $started = hrtime(true);
        $turn = PreviewTurns::take('db-a', 5, $this->directory);
        $waited = (hrtime(true) - $started) / 1e6;
        $turn->release();
        proc_close($process);
        $this->assertGreaterThan(400, $waited, 'The second Preview must wait for the first, not run beside it.');
        $this->assertLessThan(3000, $waited);
    }

    public function testDifferentDatabasesDoNotWaitForEachOther(): void
    {
        $process = $this->holder('db-b', 600);
        $started = hrtime(true);
        $turn = PreviewTurns::take('db-c', 5, $this->directory);
        $this->assertLessThan(300, (hrtime(true) - $started) / 1e6);
        $turn->release();
        proc_close($process);
    }

    public function testReleasingTwiceIsSafeAndAGivenUpWaitFailsTheStartOfThePreview(): void
    {
        $process = $this->holder('db-d', 700);
        try {
            PreviewTurns::take('db-d', 0.05, $this->directory);
            $this->fail('A turn that never came must throw.');
        } catch (\RuntimeException $error) {
            $this->assertStringContainsString('did not run', $error->getMessage());
        }
        proc_close($process);
        $first = PreviewTurns::take('db-d', 1, $this->directory);
        $first->release();
        $first->release();
        PreviewTurns::take('db-d', 1, $this->directory)->release();
    }

    public function testAPreviewWithTwoConnectionsToOneDatabaseTakesTheTurnOnce(): void
    {
        // Two configured connections (a read and a write name) that point at one database.
        $started = hrtime(true);
        $first = PreviewTurns::take('db-e', 1, $this->directory);
        $second = PreviewTurns::take('db-e', 1, $this->directory);
        $this->assertLessThan(500, (hrtime(true) - $started) / 1e6, 'The Preview must not wait for the turn it already holds.');

        $second->release();
        $process = proc_open([PHP_BINARY, '-r', sprintf('require %s; Sendproof\Core\Preview\PreviewTurns::take(%s, 0.2, %s); echo "took";', var_export(realpath(__DIR__ . '/../vendor/autoload.php'), true), var_export('db-e', true), var_export($this->directory, true))], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $this->assertStringNotContainsString('took', (string) stream_get_contents($pipes[1]), 'The turn is still held while the first connection holds it.');
        proc_close($process);

        $first->release();
        $process = proc_open([PHP_BINARY, '-r', sprintf('require %s; Sendproof\Core\Preview\PreviewTurns::take(%s, 1, %s); echo "took";', var_export(realpath(__DIR__ . '/../vendor/autoload.php'), true), var_export('db-e', true), var_export($this->directory, true))], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $this->assertSame('took', stream_get_contents($pipes[1]), 'Releasing the last hold hands the turn on.');
        proc_close($process);
    }
}
