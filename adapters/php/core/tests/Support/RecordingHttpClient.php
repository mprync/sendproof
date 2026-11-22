<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests\Support;

use GuzzleHttp\Psr7\Response;
use Http\Client\HttpAsyncClient;
use Http\Promise\FulfilledPromise;
use Http\Promise\Promise;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;

/**
 * A fake HTTP transport for the search hooks: records every request that reaches it, with its body,
 * and answers each with a plausible search reply. What it holds is what "reached the network".
 */
final class RecordingHttpClient implements ClientInterface, HttpAsyncClient
{
    /** @var list<array{method:string,url:string,body:string}> */
    public array $sent = [];

    /** @param string $reply the reply body */
    public function __construct(private readonly string $reply = '{"hits":{"hits":[{"_id":"1"}]},"result":"created","updated":2}')
    {
    }

    public function sendRequest(RequestInterface $request): ResponseInterface
    {
        $this->sent[] = ['method' => $request->getMethod(), 'url' => (string) $request->getUri(), 'body' => (string) $request->getBody()];
        $request->getBody()->rewind();

        // Elasticsearch's client refuses replies without its product header.
        return new Response(200, ['X-Elastic-Product' => 'Elasticsearch', 'Content-Type' => 'application/json'], $this->reply);
    }

    public function sendAsyncRequest(RequestInterface $request): Promise
    {
        return new FulfilledPromise($this->sendRequest($request));
    }

    /** The `METHOD path` of everything sent. @return list<string> */
    public function requests(): array
    {
        return array_map(static fn (array $sent): string => $sent['method'] . ' ' . (parse_url($sent['url'], PHP_URL_PATH) ?: '/'), $this->sent);
    }
}
