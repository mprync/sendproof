<?php

declare(strict_types=1);

namespace Fixture\Store;

use Predis\Client;
use Sendproof\Core\Stores\PreviewWriteBlockedException;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;
use Sendproof\Symfony\Attribute\AllowPreview;

/** The Redis routes of the fixture contract, through the hooked Predis service. */
final class RedisController
{
    public function __construct(private readonly Client $redis)
    {
    }

    private static function key(string $key): string
    {
        return getenv('BENCH_REDIS_PREFIX') . 'counter:' . $key;
    }

    #[Route('/counters/{key}', methods: ['GET'])]
    #[AllowPreview]
    public function read(string $key): Response
    {
        $value = $this->redis->get(self::key($key));

        return $value === null ? new JsonResponse(['title' => 'Not found'], 404) : new JsonResponse(['key' => $key, 'value' => (int) $value]);
    }

    #[Route('/counters/{key}', methods: ['POST'])]
    #[AllowPreview]
    public function increment(string $key): Response
    {
        return new JsonResponse(['key' => $key, 'value' => (int) $this->redis->incr(self::key($key))]);
    }

    /** GETDEL looks like a read but deletes the key. The handler swallows the refusal, and the Preview must still fail. */
    #[Route('/counters/{key}/take', methods: ['POST'])]
    #[AllowPreview]
    public function take(string $key): Response
    {
        try {
            $value = $this->redis->getdel(self::key($key));
        } catch (PreviewWriteBlockedException) {
            $value = '0';
        }

        return $value === null ? new JsonResponse(['title' => 'Not found'], 404) : new JsonResponse(['key' => $key, 'value' => (int) $value]);
    }

    #[Route('/counters/{key}', methods: ['DELETE'])]
    #[AllowPreview(false, stores: ['redis'])]
    public function delete(string $key): Response
    {
        $this->redis->del(self::key($key));

        return new Response('', 204);
    }
}
