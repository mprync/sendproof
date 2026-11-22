<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\Search;

use OpenSearch\Client;
use OpenSearch\ConnectionPool\AbstractConnectionPool;
use OpenSearch\ConnectionPool\SniffingConnectionPool;
use OpenSearch\Connections\Connection;
use OpenSearch\Connections\ConnectionFactory;
use OpenSearch\HttpTransport;
use OpenSearch\LegacyTransportWrapper;
use Psr\Http\Client\ClientInterface;
use Sendproof\Core\Stores\Guard;

/**
 * Write guard for `opensearch-project/opensearch-php` 2 (spec/data-stores.md, `guard` mode). The
 * library has two ways to send, and both end in one function that sees the request before any byte
 * leaves the process:
 *
 * - The PSR-18 transport (`OpenSearch\GuzzleClientFactory`, `SymfonyClientFactory`, `TransportFactory`):
 *   the HTTP client is decorated with {@see GuardedHttpClient}.
 * - The legacy RingPHP transport (`ClientBuilder`, deprecated since 2.4): the handler of every
 *   connection, and of the factory that makes more, is wrapped in a {@see GuardedRingHandler}.
 *
 * {@see install()} puts the guard into a client that already exists, whichever way it was built, and
 * so into everything that holds its transport (`$client->indices()`, `->cat()`, the helpers). A client
 * with a transport of another kind is refused, never left unguarded. {@see httpClient()} and
 * {@see handler()} are for building a client from scratch. A second client built elsewhere is not covered.
 */
final class OpenSearchGuard
{
    /** @var \WeakMap<object,true>|null */
    private static ?\WeakMap $hooked = null;

    /**
     * Hooks `$client` in place. Hooking a client twice is a no-op, so its requests are never logged twice.
     *
     * @param array<string,true>|null $reads host-declared read operation names, matched exactly
     * @param string|null $pathPrefix a path the client's hosts carry that the shared table doesn't know
     *        (legacy transport only: the PSR-18 transport adds its base path below the guard)
     * @throws \LogicException when the client sends through a transport this guard can't decorate
     */
    public static function install(Client $client, Guard $guard, ?array $reads = null, ?string $pathPrefix = null): void
    {
        self::$hooked ??= new \WeakMap();
        if (isset(self::$hooked[$client])) {
            return;
        }
        $http = \Closure::bind(fn (): mixed => $this->httpTransport, $client, Client::class)();
        if ($http instanceof HttpTransport) {
            $search = new SearchGuard($guard, 'opensearch', $reads);
            // The transport keeps its PSR-18 client in a protected property of a final class.
            \Closure::bind(function (SearchGuard $search): void {
                if (!$this->client instanceof GuardedHttpClient) {
                    $this->client = new GuardedHttpClient($this->client, $search);
                }
            }, $http, HttpTransport::class)($search);
        } elseif ($http instanceof LegacyTransportWrapper) {
            self::installLegacy($client, $guard, $reads, $pathPrefix);
        } else {
            throw new \LogicException(sprintf('Sendproof can\'t guard an OpenSearch client with a %s transport. Build the client with OpenSearch\GuzzleClientFactory, SymfonyClientFactory or ClientBuilder, or decorate its HTTP client with Sendproof\Core\Stores\Search\GuardedHttpClient.', get_debug_type($http)));
        }
        self::$hooked[$client] = true;
    }

    /**
     * The guarded HTTP client for a client built from the PSR-18 transport: give it to
     * `OpenSearch\TransportFactory::setHttpClient()`.
     *
     * @param array<string,true>|null $reads host-declared read operation names, matched exactly
     */
    public static function httpClient(ClientInterface $inner, Guard $guard, ?array $reads = null): GuardedHttpClient
    {
        return new GuardedHttpClient($inner, new SearchGuard($guard, 'opensearch', $reads));
    }

    /**
     * The guarded handler for a client built with the legacy `ClientBuilder`: pass it to
     * `ClientBuilder::setHandler()`, wrapping `ClientBuilder::defaultHandler()` or your own.
     *
     * @param array<string,true>|null $reads host-declared read operation names, matched exactly
     * @param string|null $pathPrefix a path the client's hosts carry, such as `/search`
     */
    public static function handler(callable $inner, Guard $guard, ?array $reads = null, ?string $pathPrefix = null): GuardedRingHandler
    {
        return new GuardedRingHandler($inner, new SearchGuard($guard, 'opensearch', $reads, $pathPrefix === null ? [] : [$pathPrefix]));
    }

    /** Wraps every connection of the legacy transport, and the factory that creates the next ones. */
    private static function installLegacy(Client $client, Guard $guard, ?array $reads, ?string $pathPrefix): void
    {
        // @phpstan-ignore property.deprecated
        $pool = $client->transport->connectionPool;
        $global = $pathPrefix === null ? [] : [$pathPrefix];
        \Closure::bind(function () use ($guard, $reads, $global): void {
            foreach ([...$this->connections, ...$this->seedConnections] as $connection) {
                if (!$connection instanceof Connection) {
                    throw new \LogicException('Sendproof can\'t guard an OpenSearch client whose connection pool holds a custom connection class.');
                }
                \Closure::bind(function (array $global) use ($guard, $reads): void {
                    // A connection reached through both lists, or hooked by an earlier call, is wrapped once.
                    if (!$this->handler instanceof GuardedRingHandler) {
                        $prefixes = [...$global, ...($this->path === null ? [] : [$this->path])];
                        $this->handler = new GuardedRingHandler($this->handler, new SearchGuard($guard, 'opensearch', $reads, $prefixes));
                    }
                }, $connection, Connection::class)($global);
            }
            $factory = $this->connectionFactory;
            if ($factory instanceof ConnectionFactory) {
                // Connections created later get the guarded handler.
                \Closure::bind(function () use ($guard, $reads, $global): void {
                    if (!$this->handler instanceof GuardedRingHandler) {
                        $this->handler = new GuardedRingHandler($this->handler, new SearchGuard($guard, 'opensearch', $reads, $global));
                    }
                }, $factory, ConnectionFactory::class)();
            } elseif ($this instanceof SniffingConnectionPool) {
                throw new \LogicException('Sendproof can\'t guard an OpenSearch client whose sniffing pool uses a custom connection factory: the connections it discovers would send unguarded.');
            }
        }, $pool, AbstractConnectionPool::class)();
    }
}
