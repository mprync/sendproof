<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\Search;

use Elastic\Elasticsearch\Client;
use Elastic\Transport\Exception\NoAsyncClientException;
use Elastic\Transport\Transport;
use Http\Client\HttpAsyncClient;
use Psr\Http\Client\ClientInterface;
use Sendproof\Core\Stores\Guard;

/**
 * Write guard for `elasticsearch/elasticsearch` 8 and 9 (spec/data-stores.md, `guard` mode).
 *
 * The client's transport sends every request, typed API calls, helpers and raw `sendRequest()` alike,
 * through one PSR-18 client (and, in async mode, one HTTPlug async client). The guard decorates both
 * with {@see GuardedHttpClient}, so a write is refused before it is sent. There are two ways in:
 *
 * - {@see install()} replaces the transport's clients in place, so it covers a client that already
 *   exists, however it was built, and everything that holds it.
 * - {@see httpClient()} returns the decorator for `ClientBuilder::setHttpClient()` (and
 *   `setAsyncHttpClient()`), for a client built from scratch.
 *
 * A second client built elsewhere is not covered; neither is one given its own transport after the
 * hook (`Transport::setAsyncClient()` with an unguarded client).
 */
final class ElasticsearchGuard
{
    /** @var \WeakMap<object,true>|null */
    private static ?\WeakMap $hooked = null;

    /**
     * Hooks `$client` in place. Hooking a client twice is a no-op, so its requests are never logged twice.
     *
     * @param array<string,true>|null $reads host-declared read operation names, matched exactly
     * @param string|null $pathPrefix a path the client's hosts carry that the shared table doesn't know,
     *        such as `/search` for `https://host/search`; the prefixes of the transport's own hosts are found automatically
     */
    public static function install(Client $client, Guard $guard, ?array $reads = null, ?string $pathPrefix = null): void
    {
        $transport = $client->getTransport();
        self::$hooked ??= new \WeakMap();
        if (isset(self::$hooked[$transport])) {
            return;
        }
        self::$hooked[$transport] = true;

        $search = new SearchGuard($guard, 'elasticsearch', $reads, [...self::hostPrefixes($transport), ...($pathPrefix === null ? [] : [$pathPrefix])]);
        $current = $transport->getClient();
        if (!$current instanceof GuardedHttpClient) {
            // The transport keeps its client in a private property with no setter.
            \Closure::bind(function (ClientInterface $guarded): void {
                $this->client = $guarded;
            }, $transport, Transport::class)(new GuardedAsyncHttpClient($current, $search));
        }
        // With no async client of its own, the transport sends async requests through its main client,
        // which is guarded now. One set explicitly (or found by discovery earlier) is guarded here.
        try {
            $async = $transport->getAsyncClient();
        } catch (NoAsyncClientException) {
            $async = null;
        }
        if ($async !== null && !$async instanceof GuardedHttpClient) {
            $transport->setAsyncClient(new GuardedAsyncHttpClient($async, $search));
        }
    }

    /**
     * The guarded HTTP client for a client built from scratch: give it to both `setHttpClient()` and
     * `setAsyncHttpClient()` of `Elastic\Elasticsearch\ClientBuilder`.
     *
     * @param array<string,true>|null $reads host-declared read operation names, matched exactly
     * @param string|null $pathPrefix see {@see install()}
     */
    public static function httpClient(ClientInterface|HttpAsyncClient $inner, Guard $guard, ?array $reads = null, ?string $pathPrefix = null): GuardedAsyncHttpClient
    {
        return new GuardedAsyncHttpClient($inner, new SearchGuard($guard, 'elasticsearch', $reads, $pathPrefix === null ? [] : [$pathPrefix]));
    }

    /**
     * The path prefixes of the transport's hosts, read from its node pool when that is the standard
     * one (`SimpleNodePool` keeps its nodes in a private list).
     *
     * @return list<string>
     */
    private static function hostPrefixes(Transport $transport): array
    {
        $pool = $transport->getNodePool();
        $nodes = \Closure::bind(fn (): mixed => property_exists($this, 'nodes') ? $this->nodes : null, $pool, $pool::class)();
        $prefixes = [];
        foreach (is_array($nodes) ? $nodes : [] as $node) {
            if ($node instanceof \Elastic\Transport\NodePool\Node) {
                $path = trim($node->getUri()->getPath(), '/');
                if ($path !== '') {
                    $prefixes[] = $path;
                }
            }
        }

        return $prefixes;
    }
}
