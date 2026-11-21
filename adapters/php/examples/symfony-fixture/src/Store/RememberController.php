<?php

declare(strict_types=1);

namespace Fixture\Store;

use Aws\DynamoDb\DynamoDbClient;
use Doctrine\ORM\EntityManagerInterface;
use Fixture\Entity\Item;
use Predis\Client;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;
use Sendproof\Symfony\Attribute\AllowPreview;

/** Mixed SQL and guarded store: the SQL insert rolls back with the blocked Preview. */
final class RememberController
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly ?Client $redis = null,
        private readonly ?DynamoDbClient $dynamo = null,
    ) {
    }

    #[Route('/items/{id}/remember', methods: ['POST'])]
    #[AllowPreview]
    public function remember(Request $request, string $id): Response
    {
        $data = json_decode($request->getContent(), true);
        $name = is_array($data) && is_string($data['name'] ?? null) ? $data['name'] : 'Mixed';
        $this->em->persist(new Item($id, $name));
        $this->em->flush();
        if ($request->query->get('store') === 'redis') {
            $this->redis->incr(getenv('BENCH_REDIS_PREFIX') . 'counter:item-' . $id);
        } else {
            $this->dynamo->updateItem([
                'TableName' => (string) getenv('BENCH_DYNAMODB_TABLE'), 'Key' => ['id' => ['S' => 'item-' . $id]],
                'UpdateExpression' => 'ADD hits :one SET #s = if_not_exists(#s, :new)', 'ExpressionAttributeNames' => ['#s' => 'status'],
                'ExpressionAttributeValues' => [':one' => ['N' => '1'], ':new' => ['S' => 'new']],
            ]);
        }

        return new JsonResponse(['id' => $id, 'name' => $name], 201);
    }
}
