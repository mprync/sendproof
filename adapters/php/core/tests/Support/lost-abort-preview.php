<?php

declare(strict_types=1);

/*
 * Runs one Preview in its own process, as a PHP request would: through a MongoDB client that reaches
 * the server only through tests/Support/mongo-proxy.php. The handler updates the seeded document;
 * when the engine starts its abortTransaction, the network is cut for <seconds>, so the abort is
 * lost. Prints the Preview's outcome as one JSON line, then exits, which runs the shutdown work.
 *
 *   php lost-abort-preview.php <proxy port> <control port> <database> <seconds>
 */

use MongoDB\Client;
use MongoDB\Driver\Monitoring\CommandFailedEvent;
use MongoDB\Driver\Monitoring\CommandStartedEvent;
use MongoDB\Driver\Monitoring\CommandSubscriber;
use MongoDB\Driver\Monitoring\CommandSucceededEvent;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Preview\CapturedResponse;
use Sendproof\Core\Preview\NoSqlProvider;
use Sendproof\Core\Preview\PreviewRunner;
use Sendproof\Core\Preview\PreviewState;
use Sendproof\Core\Stores\Guard;
use Sendproof\Core\Stores\MongoDb\MongoStore;

require __DIR__ . '/../../vendor/autoload.php';

[, $proxyPort, $controlPort, $database, $seconds] = $argv;

$recorder = new Recorder();
$client = new Client("mongodb://127.0.0.1:{$proxyPort}/?directConnection=true&serverSelectionTimeoutMS=1000&connectTimeoutMS=1000&appName=lost-abort");
$store = MongoStore::hook($client, new Guard(static fn () => $recorder));

/** Cuts the network as the abort starts, before the driver writes it. */
$cutter = new class ($controlPort, $seconds) implements CommandSubscriber {
    public ?float $cutAt = null;

    public function __construct(private readonly string $controlPort, private readonly string $seconds)
    {
    }

    public function commandStarted(CommandStartedEvent $event): void
    {
        if ($this->cutAt !== null || $event->getCommandName() !== 'abortTransaction') {
            return;
        }
        $control = stream_socket_client("tcp://127.0.0.1:{$this->controlPort}", $errno, $error, 2) ?: throw new RuntimeException($error);
        fwrite($control, "cut {$this->seconds}\n");
        if (trim((string) fgets($control)) !== 'ok') {
            throw new RuntimeException('The proxy did not cut the network.');
        }
        fclose($control);
        $this->cutAt = microtime(true);
    }

    public function commandSucceeded(CommandSucceededEvent $event): void
    {
    }

    public function commandFailed(CommandFailedEvent $event): void
    {
    }
};
$client->getManager()->addSubscriber($cutter);

$state = new PreviewState(hrtime(true));
$result = (new PreviewRunner($recorder))->run(new NoSqlProvider(), $state, static function () use ($store, $database, $state): CapturedResponse {
    $state->reached = true;
    $store->client()->selectCollection($database, 'documents')->updateOne(['_id' => 'seeded'], ['$set' => ['name' => 'Previewed']]);
    $state->completed = true;

    return new CapturedResponse(200, ['Content-Type' => 'application/json'], '{"ok":true}');
}, null, [$store]);

echo json_encode([
    'status' => $result->status,
    'confirmed' => $result->isConfirmed(),
    'cut' => $cutter->cutAt !== null,
    'secondsAfterCut' => $cutter->cutAt === null ? null : microtime(true) - $cutter->cutAt,
]), "\n";
fflush(STDOUT);
