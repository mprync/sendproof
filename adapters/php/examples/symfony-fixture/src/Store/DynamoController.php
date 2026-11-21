<?php

declare(strict_types=1);

namespace Fixture\Store;

use Aws\DynamoDb\DynamoDbClient;
use Aws\DynamoDb\Marshaler;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;
use Sendproof\Symfony\Attribute\AllowPreview;

/** The DynamoDB routes of the fixture contract, through the hooked AWS SDK client. */
final class DynamoController
{
    public function __construct(private readonly DynamoDbClient $dynamo)
    {
    }

    private static function table(): string
    {
        return (string) getenv('BENCH_DYNAMODB_TABLE');
    }

    /** @return array{id:mixed,status:mixed,hits:?int} */
    private static function present(array $item): array
    {
        $item = (new Marshaler())->unmarshalItem($item);

        return ['id' => $item['id'], 'status' => $item['status'] ?? null, 'hits' => isset($item['hits']) ? (int) $item['hits'] : null];
    }

    #[Route('/orders/{id}', methods: ['GET'])]
    #[AllowPreview]
    public function read(string $id): Response
    {
        $result = $this->dynamo->getItem(['TableName' => self::table(), 'Key' => ['id' => ['S' => $id]], 'ConsistentRead' => true]);

        return empty($result['Item']) ? new JsonResponse(['title' => 'Not found'], 404) : new JsonResponse(self::present($result['Item']));
    }

    #[Route('/orders/{id}/touch', methods: ['POST'])]
    #[AllowPreview]
    public function touch(string $id): Response
    {
        return new JsonResponse(self::present($this->update($id)['Attributes']));
    }

    /** A PartiQL UPDATE travels through ExecuteStatement, which also carries reads. */
    #[Route('/orders/{id}/cancel', methods: ['POST'])]
    #[AllowPreview]
    public function cancel(string $id): Response
    {
        $this->dynamo->executeStatement(['Statement' => sprintf('UPDATE "%s" SET status = \'cancelled\' WHERE id = ?', self::table()), 'Parameters' => [['S' => $id]]]);

        return new JsonResponse(['id' => $id, 'status' => 'cancelled']);
    }

    #[Route('/orders/{id}', methods: ['DELETE'])]
    #[AllowPreview(false, stores: ['dynamodb'])]
    public function delete(string $id): Response
    {
        $this->dynamo->deleteItem(['TableName' => self::table(), 'Key' => ['id' => ['S' => $id]]]);

        return new Response('', 204);
    }

    /** @return \Aws\Result */
    private function update(string $id): mixed
    {
        return $this->dynamo->updateItem([
            'TableName' => self::table(), 'Key' => ['id' => ['S' => $id]], 'UpdateExpression' => 'ADD hits :one SET #s = if_not_exists(#s, :new)',
            'ExpressionAttributeNames' => ['#s' => 'status'], 'ExpressionAttributeValues' => [':one' => ['N' => '1'], ':new' => ['S' => 'new']], 'ReturnValues' => 'ALL_NEW',
        ]);
    }
}
