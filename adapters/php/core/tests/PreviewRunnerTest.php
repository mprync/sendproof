<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use PHPUnit\Framework\TestCase;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Contracts\PreviewObservation;
use Sendproof\Core\Contracts\PreviewProvider;
use Sendproof\Core\Contracts\PreviewSession;
use Sendproof\Core\Limits;
use Sendproof\Core\Preview\CapturedResponse;
use Sendproof\Core\Preview\PreviewRunner;
use Sendproof\Core\Preview\PreviewState;

final class PreviewRunnerTest extends TestCase
{
    private function provider(?\Throwable $rollbackFails = null, ?\Throwable $beginFails = null): object
    {
        return new class($rollbackFails, $beginFails) implements PreviewProvider {
            public array $log = [];

            public function __construct(private readonly ?\Throwable $rollbackFails, private readonly ?\Throwable $beginFails)
            {
            }

            public function isAvailable(): bool
            {
                return true;
            }

            public function database(): ?string
            {
                return 'db';
            }

            public function begin(mixed $context): PreviewSession
            {
                if ($this->beginFails !== null) {
                    throw $this->beginFails;
                }
                $this->log[] = 'begin';
                $log = &$this->log;
                $fails = $this->rollbackFails;

                return new class($log, $fails) implements PreviewSession {
                    public function __construct(private array &$log, private readonly ?\Throwable $fails)
                    {
                    }

                    public function changes(): array
                    {
                        return [['operation' => 'insert', 'table' => 'items', 'key' => ['id' => 'a'], 'before' => null, 'after' => ['id' => 'a']]];
                    }

                    public function changesTruncated(): bool
                    {
                        return false;
                    }

                    public function rollback(): void
                    {
                        $this->log[] = 'rollback';
                        if ($this->fails !== null) {
                            throw $this->fails;
                        }
                    }

                    public function dispose(): void
                    {
                        $this->log[] = 'dispose';
                    }
                };
            }

            public function beginObservation(mixed $context): ?PreviewObservation
            {
                return null;
            }
        };
    }

    private function preview(object $provider, CapturedResponse|\Throwable $response, bool $completed = true, bool $reached = true): \Sendproof\Core\Preview\PreviewResult
    {
        $state = new PreviewState(hrtime(true));
        $runner = new PreviewRunner(new Recorder());

        return $runner->run($provider, $state, function () use ($response, $state, $completed, $reached): CapturedResponse {
            if ($response instanceof \Throwable) {
                throw $response;
            }
            $state->reached = $reached;
            $state->completed = $completed;

            return $response;
        }, null);
    }

    public function testConfirmsAfterRollbackAndStripsPrivateHeaders(): void
    {
        $provider = $this->provider();
        $result = $this->preview($provider, new CapturedResponse(201, ['Content-Type' => 'application/json', 'Set-Cookie' => 'a=b', 'Location' => '/x', 'X-Fixture-Tag' => 't'], '{"id":"a"}'));

        $this->assertTrue($result->isConfirmed());
        $this->assertSame(['begin', 'rollback', 'dispose'], $provider->log);
        $this->assertSame(201, $result->envelope['status']);
        $this->assertSame(['content-type' => 'application/json', 'x-fixture-tag' => 't'], (array) $result->envelope['headers']);
        $this->assertSame('a', $result->envelope['body']->id);
        $this->assertTrue($result->envelope['rolledBack']);
        $this->assertSame('insert', $result->envelope['changes'][0]['operation']);
    }

    public function testRollbackFailureWithholdsConfirmationButStillDisposes(): void
    {
        $provider = $this->provider(new \RuntimeException('boom'));
        $result = $this->preview($provider, new CapturedResponse(200, [], ''));

        $this->assertFalse($result->isConfirmed());
        $this->assertSame(500, $result->status);
        $this->assertSame(['begin', 'rollback', 'dispose'], $provider->log);
    }

    public function testExceptionInTheHandlerRollsBackAndIsUnconfirmed(): void
    {
        $provider = $this->provider();
        $result = $this->preview($provider, new \RuntimeException('handler'));

        $this->assertSame(500, $result->status);
        $this->assertSame(['begin', 'rollback', 'dispose'], $provider->log);
    }

    public function testUnhandledFailureInsideTheResponseIsUnconfirmed(): void
    {
        $result = $this->preview($this->provider(), new CapturedResponse(500, [], 'oops', new \RuntimeException('x')));

        $this->assertSame(500, $result->status);
    }

    public function testOversizedResponsesAreRejectedAfterRollback(): void
    {
        $provider = $this->provider();
        $result = $this->preview($provider, new CapturedResponse(200, ['content-type' => 'text/plain'], str_repeat('x', Limits::RESPONSE_BYTES + 1)));

        $this->assertSame(413, $result->status);
        $this->assertContains('rollback', $provider->log);
    }

    public function testDeniedStatusesAreNotConfirmedEvenWhenTheHandlerWasReached(): void
    {
        $this->assertSame(403, $this->preview($this->provider(), new CapturedResponse(403, [], '{}'))->status);
        $this->assertSame(401, $this->preview($this->provider(), new CapturedResponse(401, ['www-authenticate' => 'Bearer'], '{}'))->status);
    }

    public function testRejectionsBeforeTheHandlerKeepTheirMeaning(): void
    {
        $notFound = $this->preview($this->provider(), new CapturedResponse(404, [], ''), completed: false, reached: false);
        $redirect = $this->preview($this->provider(), new CapturedResponse(302, [], ''), completed: false, reached: false);

        $this->assertSame(404, $notFound->status);
        $this->assertSame(401, $redirect->status);
    }

    public function testBinaryBodiesAreBase64Encoded(): void
    {
        $result = $this->preview($this->provider(), new CapturedResponse(200, ['content-type' => 'application/octet-stream'], "\x00\x01"));

        $this->assertSame(base64_encode("\x00\x01"), $result->envelope['body']);
    }

    public function testBeginFailureIsUnconfirmedAndRunsNoHandler(): void
    {
        $ran = false;
        $provider = $this->provider(beginFails: new \RuntimeException('no connection'));
        $runner = new PreviewRunner(new Recorder());
        $result = $runner->run($provider, new PreviewState(hrtime(true)), function () use (&$ran): CapturedResponse {
            $ran = true;

            return new CapturedResponse(200, [], '');
        }, null);

        $this->assertFalse($ran);
        $this->assertSame(500, $result->status);
    }
}
