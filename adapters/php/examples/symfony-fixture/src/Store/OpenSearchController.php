<?php

declare(strict_types=1);

namespace Fixture\Store;

use OpenSearch\Client;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;
use Sendproof\Symfony\Attribute\AllowPreview;

/** The OpenSearch routes of the fixture contract, through the hooked OpenSearch client. */
final class OpenSearchController
{
    public function __construct(private readonly Client $search)
    {
    }

    private static function index(): string
    {
        return (string) getenv('BENCH_OPENSEARCH_INDEX');
    }

    /** @return array{id:string,title:mixed,views:?int} */
    private static function present(string $id, array $source): array
    {
        return ['id' => $id, 'title' => $source['title'] ?? null, 'views' => isset($source['views']) ? (int) $source['views'] : null];
    }

    /** A read sent as a POST: the method alone must not decide. */
    #[Route('/articles/{id}', methods: ['GET'])]
    #[AllowPreview]
    public function read(string $id): Response
    {
        $found = $this->search->search(['index' => self::index(), 'body' => ['query' => ['ids' => ['values' => [$id]]], 'size' => 1]]);

        return empty($found['hits']['hits']) ? new JsonResponse(['title' => 'Not found'], 404) : new JsonResponse(self::present($id, $found['hits']['hits'][0]['_source']));
    }

    #[Route('/articles/{id}/touch', methods: ['POST'])]
    #[AllowPreview]
    public function touch(string $id): Response
    {
        return new JsonResponse(self::present($id, $this->update($id)['get']['_source']));
    }

    /** `_update_by_query` is a POST with a query, like a search. A store error is answered as 404, even a refusal. */
    #[Route('/articles/{id}/hide', methods: ['POST'])]
    #[AllowPreview]
    public function hide(string $id): Response
    {
        try {
            $result = $this->search->updateByQuery([
                'index' => self::index(), 'refresh' => 'true',
                'body' => ['query' => ['ids' => ['values' => [$id]]], 'script' => ['source' => 'ctx._source.hidden = true']],
            ]);
        } catch (\Throwable) {
            return new JsonResponse(['title' => 'Not found'], 404);
        }

        return ($result['updated'] ?? 0) < 1 ? new JsonResponse(['title' => 'Not found'], 404) : new JsonResponse(['id' => $id, 'hidden' => true]);
    }

    #[Route('/articles/{id}', methods: ['DELETE'])]
    #[AllowPreview(false, stores: ['opensearch'])]
    public function delete(string $id): Response
    {
        $this->search->delete(['index' => self::index(), 'id' => $id, 'refresh' => 'true']);

        return new Response('', 204);
    }

    /** The upsert of the contract: `views` counts the touches, and a first touch creates the document. */
    private function update(string $id): mixed
    {
        return $this->search->update([
            'index' => self::index(), 'id' => $id, 'refresh' => 'true', '_source' => 'true',
            'body' => ['script' => ['source' => 'ctx._source.views += params.step', 'params' => ['step' => 1]], 'upsert' => ['title' => 'Untitled', 'views' => 1]],
        ]);
    }
}
