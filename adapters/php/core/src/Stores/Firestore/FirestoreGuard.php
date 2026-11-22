<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\Firestore;

use Google\ApiCore\Transport\TransportInterface;
use Google\Cloud\Firestore\FirestoreClient;
use Sendproof\Core\Stores\Guard;

/**
 * Write guard for `google/cloud-firestore` 2 (spec/data-stores.md, `guard` mode).
 *
 * The SDK's `FirestoreClient` sends every call through the transport of one generated (GAPIC) client,
 * which `DocumentReference`, `CollectionReference`, `Query`, `Transaction`, `WriteBatch` and `BulkWriter`
 * all share. {@see install()} replaces that transport in place with a {@see GuardedFirestoreTransport},
 * so a client that already exists, however it was built, is covered. {@see transport()} wraps a transport
 * for the `transport` option of a client built from scratch.
 *
 * The plan named gax interceptors (`transportConfig.grpc.interceptors`) as the hook to prove. They are
 * marked experimental and exist for gRPC only; the transport is gax's documented extension point, takes
 * the same four call types, and works on the REST fallback too, so the guard uses it. The Admin client
 * (`Google\Cloud\Firestore\Admin\V1`) and the V1 client used on its own are separate clients:
 * hook them with {@see install()} too, or they are not covered.
 */
final class FirestoreGuard
{
    /** @var \WeakMap<object,true>|null */
    private static ?\WeakMap $hooked = null;

    /**
     * Hooks `$client` in place: a `Google\Cloud\Firestore\FirestoreClient`, or a generated client such
     * as `Google\Cloud\Firestore\V1\Client\FirestoreClient`. Hooking one twice is a no-op, so its calls
     * are never logged twice.
     *
     * @param array<string,true>|null $reads host-declared read method names (`PartitionQuery`), matched exactly
     * @throws \LogicException when the client has no transport to decorate
     */
    public static function install(object $client, Guard $guard, ?array $reads = null): void
    {
        self::$hooked ??= new \WeakMap();
        if (isset(self::$hooked[$client])) {
            return;
        }
        $gapic = $client instanceof FirestoreClient
            ? \Closure::bind(fn (): object => $this->gapicClient, $client, FirestoreClient::class)()
            : $client;
        if (!property_exists($gapic, 'transport')) {
            throw new \LogicException(sprintf('Sendproof can\'t guard a %s: it has no gax transport.', $gapic::class));
        }
        \Closure::bind(function (Guard $guard, ?array $reads): void {
            if ($this->transport === null) {
                throw new \LogicException('Sendproof can\'t guard a Firestore client that was closed.');
            }
            if (!$this->transport instanceof GuardedFirestoreTransport) {
                $this->transport = new GuardedFirestoreTransport($this->transport, $guard, $reads);
            }
        }, $gapic, $gapic::class)($guard, $reads);
        self::$hooked[$client] = true;
    }

    /**
     * Wraps a transport for the `transport` option of `FirestoreClient`, for a client built from scratch.
     *
     * @param array<string,true>|null $reads host-declared read method names, matched exactly
     */
    public static function transport(TransportInterface $inner, Guard $guard, ?array $reads = null): GuardedFirestoreTransport
    {
        return new GuardedFirestoreTransport($inner, $guard, $reads);
    }
}
