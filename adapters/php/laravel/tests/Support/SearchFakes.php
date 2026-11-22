<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Tests\Support;

use Elastic\Elasticsearch\ClientBuilder;
use Google\ApiCore\Call;
use Google\ApiCore\ServerStream;
use Google\ApiCore\Transport\TransportInterface;
use Google\Cloud\Firestore\FirestoreClient;
use GuzzleHttp\Promise\FulfilledPromise;
use GuzzleHttp\Psr7\Response;
use OpenSearch\EndpointFactory;
use OpenSearch\Serializers\SmartSerializer;
use OpenSearch\TransportFactory;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;

/**
 * Real Elasticsearch, OpenSearch and Firestore clients over fake transports, for the tests that
 * check how the Laravel package hooks them. `$sent` holds everything that "reached the network".
 */
final class SearchFakes
{
    /** @var list<string> */
    public static array $sent = [];

    /** The PSR-18 fake behind the Elasticsearch and OpenSearch clients. */
    public static function http(): ClientInterface
    {
        return new class implements ClientInterface {
            public function sendRequest(RequestInterface $request): ResponseInterface
            {
                SearchFakes::$sent[] = $request->getMethod() . ' ' . $request->getUri()->getPath();

                return new Response(200, ['X-Elastic-Product' => 'Elasticsearch', 'Content-Type' => 'application/json'], '{"hits":{"hits":[]},"result":"created"}');
            }
        };
    }

    public static function elasticsearch(): \Elastic\Elasticsearch\Client
    {
        return ClientBuilder::create()->setHosts(['http://es.test:9200'])->setHttpClient(self::http())->build();
    }

    public static function opensearch(): \OpenSearch\Client
    {
        return new \OpenSearch\Client((new TransportFactory())->setHttpClient(self::http())->create(), new EndpointFactory(new SmartSerializer()), []);
    }

    public static function firestore(): FirestoreClient
    {
        $transport = new class implements TransportInterface {
            public function startUnaryCall(Call $call, array $options)
            {
                SearchFakes::$sent[] = $call->getMethod();
                $type = $call->getDecodeType();

                return new FulfilledPromise($type === null ? null : new $type());
            }

            public function startServerStreamingCall(Call $call, array $options)
            {
                SearchFakes::$sent[] = $call->getMethod();

                return new ServerStream(new class {
                    public function responses(): \Generator
                    {
                        yield from [];
                    }

                    public function getStatus(): \stdClass
                    {
                        return (object) ['code' => 0, 'details' => ''];
                    }
                });
            }

            public function startClientStreamingCall(Call $call, array $options)
            {
                SearchFakes::$sent[] = $call->getMethod();
            }

            public function startBidiStreamingCall(Call $call, array $options)
            {
                SearchFakes::$sent[] = $call->getMethod();
            }

            public function close()
            {
            }
        };
        // The emulator setting makes the client skip credentials; nothing is ever sent to it.
        putenv('FIRESTORE_EMULATOR_HOST=127.0.0.1:1');
        try {
            return new FirestoreClient(['projectId' => 'bench', 'transport' => $transport]);
        } finally {
            putenv('FIRESTORE_EMULATOR_HOST');
        }
    }
}
