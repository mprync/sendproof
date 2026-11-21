<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\Redis;

use Predis\Command\CommandInterface;
use Predis\Command\RawCommand;
use Predis\Connection\NodeConnectionInterface;
use Predis\Response\ErrorInterface;
use Sendproof\Core\Stores\CommandKind;
use Sendproof\Core\Stores\PreviewWriteBlockedException;

/**
 * Wraps a Predis node connection so every command is classified before any byte of it is written.
 *
 * The processor ({@see PredisGuardProcessor}) covers commands created through the client. This
 * decorator covers the rest: `executeRaw()`, commands built by hand, and pub/sub, none of which
 * pass through the factory. It also logs each command as a `Db` entry when it finishes, and keeps
 * a refused write from leaving the connection half-way through `MULTI` or a pipeline.
 *
 * @internal Installed by {@see PredisGuard::install()}
 */
final class GuardedPredisConnection implements NodeConnectionInterface
{
    private bool $inMulti = false;
    /** @var \SplObjectStorage<CommandInterface,array{0:CommandKind,1:int}> Pipelined commands awaiting their reply */
    private \SplObjectStorage $written;

    public function __construct(private readonly NodeConnectionInterface $inner, private readonly RedisHook $hook)
    {
        $this->written = new \SplObjectStorage();
    }

    public function connect()
    {
        $this->inner->connect();
    }

    public function disconnect()
    {
        $this->inMulti = false;
        $this->inner->disconnect();
    }

    public function isConnected()
    {
        return $this->inner->isConnected();
    }

    public function writeRequest(CommandInterface $command)
    {
        $kind = $this->check($command, true);
        $this->written[$command] = [$kind, hrtime(true)];
        $this->inner->writeRequest($command);
    }

    public function readResponse(CommandInterface $command)
    {
        $response = $this->inner->readResponse($command);
        if (isset($this->written[$command])) {
            [$kind, $started] = $this->written[$command];
            unset($this->written[$command]);
            $this->finish($command, $kind, $started, $response);
        }

        return $response;
    }

    public function write(string $buffer): void
    {
        $this->inner->write($buffer);
    }

    public function executeCommand(CommandInterface $command)
    {
        $kind = $this->check($command, false);
        $started = hrtime(true);
        try {
            $response = $this->inner->executeCommand($command);
        } catch (\Throwable $error) {
            $this->hook->record($command->getId(), array_values($command->getArguments()), $kind, $started, $error);
            throw $error;
        }
        $this->finish($command, $kind, $started, $response);

        return $response;
    }

    public function getParameters()
    {
        return $this->inner->getParameters();
    }

    public function __toString()
    {
        return (string) $this->inner;
    }

    public function getResource()
    {
        return $this->inner->getResource();
    }

    public function getClientId(): ?int
    {
        return $this->inner->getClientId();
    }

    public function addConnectCommand(CommandInterface $command)
    {
        $this->inner->addConnectCommand($command);
    }

    public function read()
    {
        return $this->inner->read();
    }

    public function hasDataToRead(): bool
    {
        return $this->inner->hasDataToRead();
    }

    public function getProtocol()
    {
        return $this->inner->getProtocol();
    }

    public function writeBuffer($buffer)
    {
        $this->inner->writeBuffer($buffer);
    }

    public function readBuffer($length)
    {
        return $this->inner->readBuffer($length);
    }

    public function readLine()
    {
        return $this->inner->readLine();
    }

    /** Anything else the wrapped connection offers (stream access, Relay methods) passes through. */
    public function __call(string $method, array $arguments): mixed
    {
        return $this->inner->{$method}(...$arguments);
    }

    /**
     * Classifies a command before it is written. A refused write discards a half-built `MULTI`, or
     * drops a connection whose pipeline is half-written, so no reply is left to mismatch.
     */
    private function check(CommandInterface $command, bool $pipelined): CommandKind
    {
        $id = strtoupper($command->getId());
        try {
            $kind = $this->hook->check($id, array_values($command->getArguments()));
        } catch (PreviewWriteBlockedException $refusal) {
            try {
                if ($this->inMulti) {
                    $this->inMulti = false;
                    $this->inner->executeCommand(new RawCommand('DISCARD', []));
                } elseif ($pipelined) {
                    $this->inner->disconnect();
                }
            } catch (\Throwable) {
                // Nothing more can be done; the refusal is what the caller sees.
            }
            throw $refusal;
        }
        if ($kind === CommandKind::Transaction) {
            $this->inMulti = $id === 'MULTI' || ($this->inMulti && $id === 'WATCH');
        }

        return $kind;
    }

    private function finish(CommandInterface $command, CommandKind $kind, int $started, mixed $response): void
    {
        $error = $response instanceof ErrorInterface ? new \RuntimeException($response->getMessage()) : null;
        $this->hook->record($command->getId(), array_values($command->getArguments()), $kind, $started, $error);
    }
}
