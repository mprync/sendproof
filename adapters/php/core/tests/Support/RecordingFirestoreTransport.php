<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests\Support;

use Google\ApiCore\Call;
use Google\ApiCore\ServerStream;
use Google\ApiCore\Transport\TransportInterface;
use Google\Cloud\Firestore\V1\BatchGetDocumentsRequest;
use Google\Cloud\Firestore\V1\BatchGetDocumentsResponse;
use Google\Cloud\Firestore\V1\BeginTransactionResponse;
use Google\Protobuf\Timestamp;
use GuzzleHttp\Promise\FulfilledPromise;

/**
 * A fake gax transport for the Firestore hook: records the method of every call that reaches it and
 * answers with an empty reply. What it holds is what "reached the network".
 */
final class RecordingFirestoreTransport implements TransportInterface
{
    /** @var list<string> the method of each call, such as `google.firestore.v1.Firestore/Commit` */
    public array $sent = [];

    public function startUnaryCall(Call $call, array $options)
    {
        $this->sent[] = ltrim($call->getMethod(), '/');
        $type = $call->getDecodeType();
        $reply = $type === null ? null : new $type();
        if ($reply instanceof BeginTransactionResponse) {
            $reply->setTransaction('tx-1');
        }

        return new FulfilledPromise($reply);
    }

    public function startServerStreamingCall(Call $call, array $options)
    {
        $this->sent[] = ltrim($call->getMethod(), '/');
        $message = $call->getMessage();
        // The SDK reads one reply per requested document: answer each as missing.
        $replies = [];
        if ($message instanceof BatchGetDocumentsRequest) {
            foreach ($message->getDocuments() as $name) {
                $replies[] = new BatchGetDocumentsResponse(['missing' => $name, 'transaction' => $message->getTransaction(), 'read_time' => new Timestamp(['seconds' => 1])]);
            }
        }

        return new ServerStream(new class ($replies) {
            /** @param list<object> $replies */
            public function __construct(private readonly array $replies)
            {
            }

            /** @return \Generator<object> */
            public function responses(): \Generator
            {
                yield from $this->replies;
            }

            public function getStatus(): \stdClass
            {
                return (object) ['code' => 0, 'details' => ''];
            }
        });
    }

    public function startClientStreamingCall(Call $call, array $options)
    {
        $this->sent[] = ltrim($call->getMethod(), '/');

        return new \stdClass();
    }

    public function startBidiStreamingCall(Call $call, array $options)
    {
        $this->sent[] = ltrim($call->getMethod(), '/');

        return new \stdClass();
    }

    public function close()
    {
    }

    /** The calls that reached the network, as the method names after the service: `['Commit']`. @return list<string> */
    public function methods(): array
    {
        return array_map(static fn (string $method): string => substr($method, (int) strrpos($method, '/') + 1), $this->sent);
    }
}
