<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use OpenSearch\Client;
use OpenSearch\ClientBuilder;
use OpenSearch\GuzzleClientFactory;
use PHPUnit\Framework\TestCase;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Stores\Guard;
use Sendproof\Core\Stores\GuardOnlyStore;
use Sendproof\Core\Stores\PreviewWriteBlockedException;
use Sendproof\Core\Stores\Search\OpenSearchGuard;
use Sendproof\Core\Tests\Support\RunsPreviews;
use Sendproof\Core\Tests\Support\Services;

/**
 * The OpenSearch write guard against a real OpenSearch (compose `heavy-stores` profile), on both ways
 * the library sends: its PSR-18 transport and its legacy RingPHP handler. Skipped when the service
 * doesn't answer. Each test makes an index of its own and removes it.
 */
final class OpenSearchServiceTest extends TestCase
{
    use RunsPreviews;

    private string $index;
    private Client $reader;

    protected function setUp(): void
    {
        Services::need('opensearch');
        $this->index = 'php_core_' . bin2hex(random_bytes(4));
        $this->reader = (new GuzzleClientFactory())->create(['base_uri' => Services::opensearchUrl()]);
        $this->reader->indices()->create(['index' => $this->index, 'body' => ['mappings' => ['properties' => ['title' => ['type' => 'keyword'], 'views' => ['type' => 'integer']]]]]);
        $this->reader->index(['index' => $this->index, 'id' => 'seeded', 'body' => ['title' => 'Seeded', 'views' => 3], 'refresh' => 'true']);
    }

    protected function tearDown(): void
    {
        if (isset($this->reader)) {
            $this->reader->indices()->delete(['index' => $this->index]);
        }
    }

    /** @return array<string,array{0:string}> */
    public static function transports(): array
    {
        return ['psr-18 transport' => ['psr18'], 'legacy handler' => ['legacy']];
    }

    /** @return array{0:Recorder,1:Client,2:GuardOnlyStore} */
    private function hooked(string $kind): array
    {
        $recorder = new Recorder();
        $client = $kind === 'psr18'
            ? (new GuzzleClientFactory())->create(['base_uri' => Services::opensearchUrl()])
            : ClientBuilder::create()->setHosts([Services::opensearchUrl()])->build();
        OpenSearchGuard::install($client, new Guard(static fn () => $recorder));

        return [$recorder, $client, new GuardOnlyStore('opensearch', 'articles')];
    }

    private function document(string $id): ?array
    {
        $found = $this->reader->exists(['index' => $this->index, 'id' => $id]);

        return $found ? $this->reader->get(['index' => $this->index, 'id' => $id])['_source'] : null;
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('transports')]
    public function testASearchPostedToTheServerRunsAndItsWritesNeverArrive(string $kind): void
    {
        [$recorder, $client, $store] = $this->hooked($kind);
        $read = $this->preview($recorder, [$store], function () use ($client): void {
            $found = $client->search(['index' => $this->index, 'body' => ['query' => ['ids' => ['values' => ['seeded']]], 'size' => 1]]);
            $this->assertSame('Seeded', $found['hits']['hits'][0]['_source']['title']);
        });
        $this->assertTrue($read->isConfirmed());
        $entry = array_values(array_filter($read->envelope['logs'], static fn (array $log): bool => $log['level'] === 'Db'))[0]['db'];
        $this->assertSame(['system' => 'opensearch', 'operation' => 'search', 'target' => $this->index, 'statement' => '{"query":{"ids":{"values":["?"]}},"size":"?"}', 'rowsAffected' => 1], $entry);

        foreach ([
            'update' => fn () => $client->update(['index' => $this->index, 'id' => 'blocked', 'body' => ['script' => ['source' => 'ctx._source.views += 1'], 'upsert' => ['title' => 'Untitled', 'views' => 1]]]),
            'update_by_query' => fn () => $client->updateByQuery(['index' => $this->index, 'body' => ['query' => ['ids' => ['values' => ['seeded']]], 'script' => ['source' => 'ctx._source.hidden = true']]]),
            'delete' => fn () => $client->delete(['index' => $this->index, 'id' => 'seeded']),
            'bulk' => fn () => $client->bulk(['body' => [['delete' => ['_index' => $this->index, '_id' => 'seeded']]]]),
        ] as $operation => $write) {
            $result = $this->preview($recorder, [$store], function () use ($write): void {
                try {
                    $write();
                } catch (PreviewWriteBlockedException) {
                }
            });
            $this->assertSame(409, $result->status, $operation);
            $this->assertSame($operation, $result->problem()['operation']);
        }
        $this->reader->indices()->refresh(['index' => $this->index]);
        $this->assertNull($this->document('blocked'), 'The upsert must not reach OpenSearch');
        $this->assertSame(['title' => 'Seeded', 'views' => 3], $this->document('seeded'), 'Nothing the Preview sent may change the seeded document');
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('transports')]
    public function testObservedSendCommitsOnceAndLogsTheWriteWithoutItsValues(string $kind): void
    {
        [$recorder, $client] = $this->hooked($kind);
        $recorder->begin(false);
        $client->update(['index' => $this->index, 'id' => 'sent', 'refresh' => 'true', 'body' => ['script' => ['source' => 'ctx._source.views += 1'], 'upsert' => ['title' => 'Untitled', 'views' => 1]]]);
        $db = array_values(array_filter($recorder->finish()['logs'], static fn (array $log): bool => $log['level'] === 'Db'));
        $this->assertSame(['update'], array_map(static fn (array $log): string => $log['db']['operation'], $db));
        $this->assertSame($this->index, $db[0]['db']['target']);
        $this->assertStringNotContainsString('Untitled', json_encode($db));
        $this->assertStringNotContainsString('ctx._source', json_encode($db));
        $this->assertSame(['title' => 'Untitled', 'views' => 1], $this->document('sent'));
    }

    public function testAnErrorReplyIsLoggedAndStillThrownToTheHandler(): void
    {
        [$recorder, $client] = $this->hooked('psr18');
        $recorder->begin(false);
        try {
            $client->get(['index' => $this->index, 'id' => 'missing']);
            $this->fail('A missing document is a 404');
        } catch (\OpenSearch\Exception\NotFoundHttpException) {
        }
        $db = array_values(array_filter($recorder->finish()['logs'], static fn (array $log): bool => $log['level'] === 'Db'));
        $this->assertSame('get', $db[0]['db']['operation']);
        $this->assertSame('404', $db[0]['db']['error']);
    }
}
