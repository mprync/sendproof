<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Tests;

use Aws\DynamoDb\DynamoDbClient;
use Illuminate\Support\Facades\Route;
use Sendproof\Core\Stores\PreviewWriteBlockedException;

/** The Laravel DynamoDB hook: a container-held `DynamoDbClient` listed in `sendproof.data_stores`. */
final class DynamoPreviewTest extends StoresTestCase
{
    private string $table;
    private DynamoDbClient $reader;

    protected function stores(): array
    {
        return ['dynamodb'];
    }

    private function client(): DynamoDbClient
    {
        return new DynamoDbClient(['region' => 'us-east-1', 'version' => 'latest', 'endpoint' => Services::dynamodbUrl(), 'credentials' => ['key' => 'benchlocal', 'secret' => 'benchDynamoSecret-laravel']]);
    }

    protected function configure($app): void
    {
        $this->table = 'laravel_' . bin2hex(random_bytes(4));
        $app->singleton(DynamoDbClient::class, fn () => $this->client());
        $app['config']->set('sendproof.data_stores', ['dynamodb' => ['clients' => [DynamoDbClient::class], 'name' => 'orders']]);
        $this->reader = $this->client();
        $this->reader->createTable([
            'TableName' => $this->table, 'BillingMode' => 'PAY_PER_REQUEST',
            'AttributeDefinitions' => [['AttributeName' => 'id', 'AttributeType' => 'S']], 'KeySchema' => [['AttributeName' => 'id', 'KeyType' => 'HASH']],
        ]);
        $this->reader->putItem(['TableName' => $this->table, 'Item' => ['id' => ['S' => 'seeded'], 'status' => ['S' => 'open']]]);
    }

    protected function tearDown(): void
    {
        if (isset($this->reader, $this->table)) {
            $this->reader->deleteTable(['TableName' => $this->table]);
        }
        parent::tearDown();
    }

    protected function storeRoutes(): void
    {
        Route::get('/orders/{id}', fn (string $id) => response()->json(['status' => $this->app->make(DynamoDbClient::class)->getItem(['TableName' => $this->table, 'Key' => ['id' => ['S' => $id]]])['Item']['status']['S'] ?? null]))->sendproofPreview();
        Route::post('/orders/{id}/cancel', function (string $id) {
            try {
                $this->app->make(DynamoDbClient::class)->executeStatement(['Statement' => "UPDATE \"{$this->table}\" SET status = 'cancelled' WHERE id = ?", 'Parameters' => [['S' => $id]]]);
            } catch (PreviewWriteBlockedException) {
            }

            return response()->json(['ok' => true]);
        })->sendproofPreview();
        Route::delete('/orders/{id}', fn (string $id) => response()->noContent())->sendproofPreview(false, stores: ['dynamodb']);
    }

    public function testDiscoveryReadsAndBlockedWrites(): void
    {
        $this->signIn();
        $capabilities = $this->capabilities();
        $this->assertSame([['system' => 'dynamodb', 'name' => 'orders', 'mode' => 'guard']], $capabilities['dataStores']);
        $this->assertSame('Preview unavailable: this operation writes to DynamoDB', $capabilities['previewUnavailable'][0]['reason'], 'The reason defaults to the first store.');

        $read = $this->preview('/orders/seeded', method: 'GET')->assertOk()->assertJsonPath('body.status', 'open')->json();
        $this->assertSame('GetItem', $this->dbEntries($read, 'dynamodb')[0]['db']['operation']);
        $this->assertStringNotContainsString('benchDynamoSecret-laravel', json_encode($read));

        $this->preview('/orders/seeded/cancel')->assertStatus(409)->assertJson(['store' => 'dynamodb', 'operation' => 'ExecuteStatement']);
        $this->assertSame('open', $this->reader->getItem(['TableName' => $this->table, 'Key' => ['id' => ['S' => 'seeded']], 'ConsistentRead' => true])['Item']['status']['S']);
    }

    public function testAClientTheContainerBuildsAfterTheHookIsGuardedToo(): void
    {
        // A binding that isn't shared hands out a new client on every resolve, each built after boot.
        $this->app->bind(DynamoDbClient::class, fn () => $this->client());
        $this->signIn();
        $this->preview('/orders/seeded/cancel')->assertStatus(409);
        $this->assertSame('open', $this->reader->getItem(['TableName' => $this->table, 'Key' => ['id' => ['S' => 'seeded']], 'ConsistentRead' => true])['Item']['status']['S']);
    }

    public function testAnOperationMarkedUnavailableIsNeverRun(): void
    {
        $this->signIn();
        $this->preview('/orders/seeded', method: 'DELETE')->assertStatus(409);
    }
}
