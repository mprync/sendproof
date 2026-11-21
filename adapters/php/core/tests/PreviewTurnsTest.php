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
        $first = PreviewTurns::take('db-d', 1, $this->directory);
        try {
            PreviewTurns::take('db-d', 0.05, $this->directory);
            $this->fail('A turn that never came must throw.');
        } catch (\RuntimeException $error) {
            $this->assertStringContainsString('did not run', $error->getMessage());
        }
        $first->release();
        $first->release();
        PreviewTurns::take('db-d', 1, $this->directory)->release();
    }
}
