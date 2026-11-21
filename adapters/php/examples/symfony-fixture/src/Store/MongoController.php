<?php

declare(strict_types=1);

namespace Fixture\Store;

use MongoDB\Client;
use Psr\Log\LoggerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;
use Sendproof\Symfony\Attribute\AllowPreview;

/** The MongoDB routes of the fixture contract, through the guarded `MongoDB\Client` service. */
final class MongoController
{
    public function __construct(private readonly Client $client, private readonly LoggerInterface $logger)
    {
    }

    private function documents(): \MongoDB\Collection
    {
        return $this->client->selectCollection(ltrim((string) parse_url((string) getenv('BENCH_MONGODB_URL'), PHP_URL_PATH), '/'), 'documents');
    }

    /** @return array{id:mixed,name:mixed,city:mixed} */
    private static function present(object|array $document): array
    {
        $fields = (array) $document;

        return ['id' => $fields['_id'], 'name' => $fields['name'], 'city' => ((array) ($fields['profile'] ?? []))['city'] ?? null];
    }

    #[Route('/documents/{id}', methods: ['GET'])]
    #[AllowPreview]
    public function read(string $id): Response
    {
        $document = $this->documents()->findOne(['_id' => $id]);

        return $document === null ? new JsonResponse(['title' => 'Not found'], 404) : new JsonResponse(self::present($document));
    }

    #[Route('/documents', methods: ['POST'])]
    #[AllowPreview]
    public function create(Request $request): Response
    {
        $data = json_decode($request->getContent(), true);
        $this->documents()->insertOne(['_id' => $data['id'], 'name' => $data['name'], 'profile' => ['city' => $data['city']], 'password_hash' => 'hashed:' . $data['password']]);
        $this->logger->info('created-document:' . $data['id']);

        return new JsonResponse(['id' => $data['id'], 'name' => $data['name'], 'city' => $data['city']], 201);
    }

    #[Route('/documents/archive', methods: ['POST'], priority: 1)]
    #[AllowPreview]
    public function archive(): Response
    {
        // $out can't run inside a transaction, so Preview blocks it before it is sent.
        iterator_to_array($this->documents()->aggregate([['$match' => new \stdClass()], ['$out' => 'documents_archive']]));

        return new Response('', 204);
    }

    #[Route('/documents/{id}', methods: ['PATCH'])]
    #[AllowPreview]
    public function update(Request $request, string $id): Response
    {
        $data = json_decode($request->getContent(), true) ?: [];
        $set = array_filter(['name' => $data['name'] ?? null, 'profile.city' => $data['city'] ?? null], static fn ($value) => $value !== null);
        $result = $this->documents()->updateOne(['_id' => $id], ['$set' => $set]);
        if ($result->getMatchedCount() === 0) {
            return new JsonResponse(['title' => 'Not found'], 404);
        }

        return new JsonResponse(self::present($this->documents()->findOne(['_id' => $id])));
    }

    #[Route('/documents/{id}', methods: ['DELETE'])]
    #[AllowPreview(false, stores: ['mongodb'])]
    public function delete(string $id): Response
    {
        $this->documents()->deleteOne(['_id' => $id]);

        return new Response('', 204);
    }
}
