<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use PHPUnit\Framework\Attributes\PreserveGlobalState;
use PHPUnit\Framework\Attributes\RunInSeparateProcess;
use PHPUnit\Framework\TestCase;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Stores\Guard;
use Sendproof\Core\Stores\InternalProperty;
use Sendproof\Core\Stores\Search\ElasticsearchGuard;
use Sendproof\Core\Stores\Search\OpenSearchGuard;

/**
 * The search hooks replace private properties of the client libraries, which have no setters. If a
 * release renames one, the hook must refuse to start (a `LogicException` when the client is hooked),
 * never write a stray property and leave the client sending unguarded. Each check loads a stand-in
 * for the library class with the property renamed, in a process of its own, before the real class
 * is ever autoloaded.
 */
final class ElasticsearchLayoutTest extends TestCase
{
    #[RunInSeparateProcess]
    #[PreserveGlobalState(false)]
    public function testAnElasticsearchTransportWhoseClientPropertyMovedIsRefusedAtStartup(): void
    {
        // elastic/transport's final Transport, with its PSR-18 client kept under another name.
        eval(<<<'PHP'
            namespace Elastic\Transport;

            final class Transport implements \Psr\Http\Client\ClientInterface
            {
                public array $sent = [];
                private \Psr\Http\Client\ClientInterface $httpClient;

                public function __construct(\Psr\Http\Client\ClientInterface $client)
                {
                    $this->httpClient = $client;
                }

                public function getClient(): \Psr\Http\Client\ClientInterface
                {
                    return $this->httpClient;
                }

                public function getNodePool(): object
                {
                    return new \stdClass();
                }

                public function getAsyncClient(): never
                {
                    throw new \Elastic\Transport\Exception\NoAsyncClientException('none');
                }

                public function sendRequest(\Psr\Http\Message\RequestInterface $request): \Psr\Http\Message\ResponseInterface
                {
                    return $this->httpClient->sendRequest($request);
                }

                public function __call(string $name, array $arguments): self
                {
                    return $this;
                }
            }
            PHP);
        $fake = new Support\RecordingHttpClient();
        $client = new \Elastic\Elasticsearch\Client(new \Elastic\Transport\Transport($fake), new \Psr\Log\NullLogger());
        try {
            ElasticsearchGuard::install($client, new Guard(static fn () => new Recorder()));
            $this->fail('The hook started on a transport it could not guard.');
        } catch (\LogicException $refusal) {
            $this->assertStringContainsString("can't guard an Elasticsearch client", $refusal->getMessage());
        }
        $this->assertFalse(isset(\Closure::bind(fn (): array => get_object_vars($this), $client->getTransport(), \Elastic\Transport\Transport::class)()['client']), 'No stray property was written');
    }

    #[RunInSeparateProcess]
    #[PreserveGlobalState(false)]
    public function testAnOpenSearchConnectionWhoseHandlerPropertyMovedIsRefusedAtStartup(): void
    {
        // opensearch-php's legacy Connection, with its RingPHP handler kept under another name.
        eval(<<<'PHP'
            namespace OpenSearch\Connections;

            class Connection
            {
                protected $requestHandler;

                public function __construct(callable $handler)
                {
                    $this->requestHandler = $handler;
                }
            }
            PHP);
        $connection = new \OpenSearch\Connections\Connection(static fn () => throw new \LogicException('sent'));
        $serializer = new \OpenSearch\Serializers\SmartSerializer();
        $factory = new \OpenSearch\Connections\ConnectionFactory(static fn () => null, [], $serializer, new \Psr\Log\NullLogger(), new \Psr\Log\NullLogger());
        $pool = new \OpenSearch\ConnectionPool\StaticNoPingConnectionPool([$connection], new \OpenSearch\ConnectionPool\Selectors\RoundRobinSelector(), $factory, []);
        $client = @new \OpenSearch\Client(new \OpenSearch\Transport(0, $pool, new \Psr\Log\NullLogger()), new \OpenSearch\EndpointFactory($serializer), []);
        $this->expectException(\LogicException::class);
        $this->expectExceptionMessage("can't guard an OpenSearch client");
        OpenSearchGuard::install($client, new Guard(static fn () => new Recorder()));
    }

    public function testAMissingReadOnlyOrUninitialisedPropertyFailsClosed(): void
    {
        $target = new class {
            public readonly object $fixed;
            private object $late;
            private object $kept;

            public function __construct()
            {
                $this->fixed = new \stdClass();
                $this->kept = new \stdClass();
            }
        };
        $wrap = static fn (object $inner): object => new \ArrayObject([$inner]);
        foreach (['missing', 'fixed', 'late'] as $name) {
            try {
                InternalProperty::replace($target, $target::class, $name, $wrap, 'a test client');
                $this->fail($name . ' was replaced');
            } catch (\LogicException $refusal) {
                $this->assertStringContainsString('$' . $name, $refusal->getMessage());
            }
        }
        $this->assertInstanceOf(\ArrayObject::class, InternalProperty::replace($target, $target::class, 'kept', $wrap, 'a test client'));
        $this->assertFalse(property_exists($target, 'missing'), 'No stray property was written');
    }
}
