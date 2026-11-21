<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use Aws\DynamoDb\DynamoDbClient;
use PHPUnit\Framework\TestCase;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Stores\DynamoDb\DynamoGuard;
use Sendproof\Core\Stores\Guard;
use Sendproof\Core\Stores\GuardOnlyStore;
use Sendproof\Core\Stores\PreviewWriteBlockedException;
use Sendproof\Core\Tests\Support\RunsPreviews;
use Sendproof\Core\Tests\Support\Services;

/** The DynamoDB write guard on the AWS SDK client (spec/data-stores.md, `guard` mode), against DynamoDB Local. */
final class DynamoStoreTest extends TestCase
{
    use RunsPreviews;

    private const SECRET = 'benchDynamoSecret-php-core';

    private string $table;
    private DynamoDbClient $reader;

    protected function setUp(): void
    {
        Services::need('dynamodb');
        $this->table = 'php_core_' . bin2hex(random_bytes(4));
        $this->reader = $this->client();
        $this->reader->createTable([
            'TableName' => $this->table, 'BillingMode' => 'PAY_PER_REQUEST',
            'AttributeDefinitions' => [['AttributeName' => 'id', 'AttributeType' => 'S']], 'KeySchema' => [['AttributeName' => 'id', 'KeyType' => 'HASH']],
        ]);
        $this->reader->putItem(['TableName' => $this->table, 'Item' => ['id' => ['S' => 'seeded'], 'status' => ['S' => 'open'], 'hits' => ['N' => '3']]]);
    }

    protected function tearDown(): void
    {
        if (isset($this->reader)) {
            $this->reader->deleteTable(['TableName' => $this->table]);
        }
    }

    private function client(): DynamoDbClient
    {
        return new DynamoDbClient(['region' => 'us-east-1', 'version' => 'latest', 'endpoint' => Services::dynamodbUrl(), 'credentials' => ['key' => 'benchlocal', 'secret' => self::SECRET]]);
    }

    /** @return array{0:Recorder,1:DynamoDbClient,2:GuardOnlyStore} */
    private function hooked(?array $reads = null): array
    {
        $recorder = new Recorder();
        $client = $this->client();
        DynamoGuard::install($client, new Guard(static fn () => $recorder), $reads);

        return [$recorder, $client, new GuardOnlyStore('dynamodb', 'orders')];
    }

    private function seededStatus(): ?string
    {
        return $this->reader->getItem(['TableName' => $this->table, 'Key' => ['id' => ['S' => 'seeded']], 'ConsistentRead' => true])['Item']['status']['S'] ?? null;
    }

    public function testReadsRunAndWritesAreRefusedBeforeARequestIsBuilt(): void
    {
        [$recorder, $client, $store] = $this->hooked();
        $read = $this->preview($recorder, [$store], fn () => $client->getItem(['TableName' => $this->table, 'Key' => ['id' => ['S' => 'seeded']]]));
        $this->assertTrue($read->isConfirmed());
        $entry = array_values(array_filter($read->envelope['logs'], static fn (array $log): bool => $log['level'] === 'Db'))[0]['db'];
        $this->assertSame(['system' => 'dynamodb', 'operation' => 'GetItem', 'target' => $this->table, 'rowsAffected' => 1], $entry);

        foreach ([
            'UpdateItem' => fn () => $client->updateItem(['TableName' => $this->table, 'Key' => ['id' => ['S' => 'blocked']], 'UpdateExpression' => 'ADD hits :one', 'ExpressionAttributeValues' => [':one' => ['N' => '1']], 'ReturnValues' => 'ALL_NEW']),
            'PutItem' => fn () => $client->putItem(['TableName' => $this->table, 'Item' => ['id' => ['S' => 'put']]]),
            'DeleteItem' => fn () => $client->deleteItem(['TableName' => $this->table, 'Key' => ['id' => ['S' => 'seeded']]]),
            'ExecuteStatement' => fn () => $client->executeStatement(['Statement' => "UPDATE \"{$this->table}\" SET status = 'cancelled' WHERE id = ?", 'Parameters' => [['S' => 'seeded']]]),
        ] as $operation => $call) {
            $result = $this->preview($recorder, [$store], function () use ($call): void {
                try {
                    $call();
                } catch (PreviewWriteBlockedException) {
                }
            });
            $this->assertSame(409, $result->status, $operation);
            $this->assertSame($operation, $result->problem()['operation']);
        }
        $this->assertSame('open', $this->seededStatus(), 'No write may reach DynamoDB during a Preview.');
        $this->assertArrayNotHasKey('Item', $this->reader->getItem(['TableName' => $this->table, 'Key' => ['id' => ['S' => 'blocked']], 'ConsistentRead' => true])->toArray());
    }

    public function testPartiqlSelectIsAReadAndInlineLiteralsAreReplacedInTheLog(): void
    {
        [$recorder, $client, $store] = $this->hooked();
        $result = $this->preview($recorder, [$store], fn () => $client->executeStatement(['Statement' => "SELECT * FROM \"{$this->table}\" WHERE id = 'seeded' AND hits > 2"]));
        $this->assertTrue($result->isConfirmed());
        $entry = array_values(array_filter($result->envelope['logs'], static fn (array $log): bool => $log['level'] === 'Db'))[0]['db'];
        $this->assertSame("SELECT * FROM \"{$this->table}\" WHERE id = ? AND hits > ?", $entry['statement']);
        $this->assertStringNotContainsString('seeded', json_encode($result->envelope['logs']));
        // Single-quoted text is a literal wherever it appears, tuple keys included.
        $this->assertSame("INSERT INTO \"t\" VALUE {?: ?, ?: ?}", DynamoGuard::sanitizePartiql("INSERT INTO \"t\" VALUE {'id': 'it''s', 'n': 42.5e3}"));
        $this->assertSame('SELECT a1 FROM "t2" WHERE b = ?', DynamoGuard::sanitizePartiql("SELECT a1 FROM \"t2\" WHERE b = 7"));
    }

    public function testCredentialsAndSignaturesNeverReachACapture(): void
    {
        [$recorder, $client, $store] = $this->hooked();
        $result = $this->preview($recorder, [$store], fn () => $client->getItem(['TableName' => $this->table, 'Key' => ['id' => ['S' => 'seeded']]]));
        $text = json_encode($result->envelope);
        foreach ([self::SECRET, 'AWS4-HMAC-SHA256', 'benchlocal'] as $secret) {
            $this->assertStringNotContainsString($secret, $text);
        }
    }

    public function testObservedSendCommitsOnceAndATransactionOfOnlyConditionChecksIsStillAWrite(): void
    {
        [$recorder, $client] = $this->hooked();
        $recorder->begin(false);
        $client->updateItem(['TableName' => $this->table, 'Key' => ['id' => ['S' => 'sent']], 'UpdateExpression' => 'ADD hits :one', 'ExpressionAttributeValues' => [':one' => ['N' => '1']]]);
        $capture = $recorder->finish();
        $this->assertSame('1', $this->reader->getItem(['TableName' => $this->table, 'Key' => ['id' => ['S' => 'sent']], 'ConsistentRead' => true])['Item']['hits']['N']);
        $this->assertSame(['UpdateItem'], array_values(array_map(static fn (array $log): string => $log['db']['operation'], array_filter($capture['logs'], static fn (array $log): bool => $log['level'] === 'Db'))));
    }

    public function testTheGuardChecksFailWhenTheHookIsRemoved(): void
    {
        $recorder = new Recorder();
        $unhooked = $this->client();
        $result = $this->preview($recorder, [new GuardOnlyStore('dynamodb')], function () use ($unhooked): void {
            $unhooked->updateItem(['TableName' => $this->table, 'Key' => ['id' => ['S' => 'seeded']], 'UpdateExpression' => 'SET #s = :c', 'ExpressionAttributeNames' => ['#s' => 'status'], 'ExpressionAttributeValues' => [':c' => ['S' => 'changed']]]);
        });
        $this->assertTrue($result->isConfirmed(), 'Without the hook nothing marks the write, so the Preview is wrongly confirmed.');
        $this->assertSame('changed', $this->seededStatus(), 'The unhooked write reached DynamoDB: exactly what the hook prevents.');
    }
}
