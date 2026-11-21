<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use PHPUnit\Framework\TestCase;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Preview\CapturedResponse;
use Sendproof\Core\Preview\NoSqlProvider;
use Sendproof\Core\Preview\PreviewRunner;
use Sendproof\Core\Preview\PreviewState;
use Sendproof\Core\Stores\Classifier;
use Sendproof\Core\Stores\DataStore;
use Sendproof\Core\Stores\Guard;
use Sendproof\Core\Stores\PreviewWriteBlockedException;
use Sendproof\Core\Capabilities;

/** The guard, the Preview pipeline order and discovery (spec/data-stores.md "The shared core every binding adds"). */
final class StoreGuardTest extends TestCase
{
    /** A stand-in store whose hook calls the guard, or skips it when `$hooked` is false. */
    private function store(Recorder $recorder, bool $hooked = true, ?\Closure $finish = null): object
    {
        return new class(new Guard(fn () => $recorder), $hooked, $finish) implements DataStore {
            /** @var list<string> */
            public array $writes = [];

            public function __construct(private readonly Guard $guard, private readonly bool $hooked, private readonly ?\Closure $finish)
            {
            }

            public function system(): string
            {
                return 'redis';
            }

            public function describe(): array
            {
                return ['system' => 'redis', 'name' => 'cache', 'mode' => 'guard'];
            }

            public function begin(Recorder $recorder): void
            {
            }

            public function finish(Recorder $recorder): void
            {
                $this->finish !== null && ($this->finish)();
            }

            public function incr(string $key): void
            {
                if ($this->hooked) {
                    $this->guard->guard('redis', 'INCR', Classifier::redis('INCR', [$key]));
                }
                $this->writes[] = $key;
            }
        };
    }

    private function runPreview(Recorder $recorder, object $store, \Closure $handler): \Sendproof\Core\Preview\PreviewResult
    {
        $state = new PreviewState(hrtime(true));

        return (new PreviewRunner($recorder))->run(new NoSqlProvider(), $state, function () use ($handler, $state): CapturedResponse {
            $state->reached = true;
            $response = $handler();
            $state->completed = true;

            return $response;
        }, null, [$store]);
    }

    private function ok(): CapturedResponse
    {
        return new CapturedResponse(200, ['Content-Type' => 'application/json'], '{"ok":true}');
    }

    public function testTheGuardDoesNothingOutsideAPreviewAndBlocksAWriteInsideOne(): void
    {
        $recorder = new Recorder();
        $guard = new Guard(fn () => $recorder);
        $guard->guard('redis', 'INCR', Classifier::redis('INCR', ['k']));
        $recorder->begin(false);
        $guard->guard('redis', 'INCR', Classifier::redis('INCR', ['k']));

        $recorder->begin(true);
        $guard->guard('redis', 'GET', Classifier::redis('GET', ['k']));
        try {
            $guard->guard('redis', 'INCR', Classifier::redis('INCR', ['k']));
            $this->fail('A write must be refused in a Preview.');
        } catch (PreviewWriteBlockedException $error) {
            $this->assertSame(['redis', 'INCR'], [$error->store, $error->operation]);
        }
        $this->expectException(PreviewWriteBlockedException::class);
        try {
            $guard->guard('dynamodb', 'PutItem', Classifier::dynamo('PutItem'));
        } finally {
            // The first block wins, and each refused command is logged as a blocked Db entry.
            $this->assertSame(['store' => 'redis', 'operation' => 'INCR', 'detail' => 'Preview unavailable: this operation writes to Redis'], $recorder->blocked());
            $logs = $recorder->finish()['logs'];
            $this->assertSame([['INCR', true], ['PutItem', true]], array_map(static fn (array $entry): array => [$entry['db']['operation'], $entry['db']['blocked']], $logs));
        }
    }

    public function testAWriteSentAfterThePreviewFinishedIsStillRefused(): void
    {
        $recorder = new Recorder();
        $recorder->begin(true);
        $recorder->finish();
        $this->expectException(PreviewWriteBlockedException::class);
        (new Guard(fn () => $recorder))->guard('redis', 'SET', Classifier::redis('SET', ['k', 'v']));
    }

    /** The binding's own guard checks. They pass for a hooked store; the negative test runs them unhooked. */
    private function guardChecks(bool $hooked): void
    {
        $recorder = new Recorder();
        $store = $this->store($recorder, $hooked);

        $direct = $this->runPreview($recorder, $store, function () use ($store): CapturedResponse {
            $store->incr('a');

            return $this->ok();
        });
        $this->assertSame(409, $direct->status, 'A write must block the Preview.');
        $this->assertNull($direct->envelope);
        $this->assertSame(['type' => 'about:blank', 'title' => 'Preview unavailable', 'status' => 409, 'code' => 'preview_unavailable', 'detail' => 'Preview unavailable: this operation writes to Redis', 'store' => 'redis', 'operation' => 'INCR', 'rolledBack' => false], $direct->problem());

        // The handler catches the refusal and claims success: the mark still decides the outcome.
        $swallowed = $this->runPreview($recorder, $store, function () use ($store): CapturedResponse {
            try {
                $store->incr('b');
            } catch (PreviewWriteBlockedException) {
                // Ignored.
            }

            return $this->ok();
        });
        $this->assertSame(409, $swallowed->status, 'A handler that returns 200 after a refusal still gets the 409.');
        $this->assertSame([], $store->writes, 'No write may reach the store during a Preview.');
    }

    public function testABlockedPreviewAnswers409EvenWhenTheHandlerCatchesTheErrorAndReturns200(): void
    {
        $this->guardChecks(true);
    }

    public function testTheGuardChecksFailWhenTheHookIsRemoved(): void
    {
        // Proof that the checks above catch a binding that lets writes through.
        $this->expectException(\PHPUnit\Framework\AssertionFailedError::class);
        $this->guardChecks(false);
    }

    public function testAHandlerThatThrowsTheBlockedErrorStillGets409ButAnyOtherErrorGets500(): void
    {
        $recorder = new Recorder();
        $store = $this->store($recorder);
        $blocked = $this->runPreview($recorder, $store, function () use ($store): never {
            $store->incr('x');
            throw new \LogicException('unreachable');
        });
        $this->assertSame(409, $blocked->status);

        $other = $this->runPreview($recorder, $store, function () use ($store): never {
            try {
                $store->incr('x');
            } catch (PreviewWriteBlockedException) {
            }
            throw new \RuntimeException('boom');
        });
        $this->assertSame(500, $other->status);
        $this->assertNull($other->blocked);
    }

    public function testAFailedStoreAbortAndARecordedFaultOutrankABlockedWrite(): void
    {
        $recorder = new Recorder();
        $failing = $this->store($recorder, true, static fn () => throw new \RuntimeException('abort failed'));
        $result = $this->runPreview($recorder, $failing, function () use ($failing): CapturedResponse {
            try {
                $failing->incr('x');
            } catch (PreviewWriteBlockedException) {
            }

            return $this->ok();
        });
        $this->assertSame(500, $result->status);
        $this->assertNull($result->blocked);

        $store = $this->store($recorder);
        $faulted = $this->runPreview($recorder, $store, function () use ($store, $recorder): CapturedResponse {
            try {
                $store->incr('x');
            } catch (PreviewWriteBlockedException) {
            }
            (new Guard(fn () => $recorder))->refuse('handler commit');

            return $this->ok();
        });
        $this->assertSame(500, $faulted->status);
        $this->assertNull($faulted->envelope);
    }

    public function testPreviewRunsWithoutASqlProviderWhenOnlyHookedStoresExist(): void
    {
        $recorder = new Recorder();
        $store = $this->store($recorder);
        $confirmed = $this->runPreview($recorder, $store, fn (): CapturedResponse => $this->ok());
        $this->assertTrue($confirmed->isConfirmed());
        $this->assertTrue($confirmed->envelope['rolledBack']);
    }

    public function testDiscoveryListsStoresUnavailableOperationsBindingAndDatabaseSystem(): void
    {
        $capabilities = Capabilities::build(
            'Inventory', 'local', '/openapi.json', [], [], 'items.sqlite', null, [], [['method' => 'GET', 'path' => '/counters/{key}']],
            ['language' => 'php', 'framework' => 'Laravel'],
            [['system' => 'redis', 'name' => 'cache', 'mode' => 'guard']],
            [['method' => 'DELETE', 'path' => '/counters/{key}', 'reason' => 'Preview unavailable: this operation writes to Redis', 'stores' => ['redis']]],
            'sqlite',
        );
        $this->assertSame(['name' => 'items.sqlite', 'system' => 'sqlite'], $capabilities['database']);
        $this->assertSame(['language' => 'php', 'framework' => 'Laravel'], $capabilities['binding']);
        $this->assertSame([['system' => 'redis', 'name' => 'cache', 'mode' => 'guard']], $capabilities['dataStores']);
        $this->assertSame('DELETE', $capabilities['previewUnavailable'][0]['method']);

        $bare = Capabilities::build('A', 'local', '/openapi.json', [], [], null, null, [], []);
        $this->assertArrayNotHasKey('dataStores', $bare);
        $this->assertArrayNotHasKey('previewUnavailable', $bare);
        $this->assertNull($bare['database']);
    }
}
