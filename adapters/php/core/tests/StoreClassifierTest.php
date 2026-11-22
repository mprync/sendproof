<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use PHPUnit\Framework\TestCase;
use Sendproof\Core\Capture\SqlRedactor;
use Sendproof\Core\Stores\Classifier;
use Sendproof\Core\Stores\CommandKind;
use Sendproof\Core\Stores\Guard;
use Sendproof\Core\Stores\Tables;

/** The embedded tables match the spec, and the classifiers pass every shared vector. */
final class StoreClassifierTest extends TestCase
{
    private const SPEC = __DIR__ . '/../../../../spec/data-stores/';

    private function spec(string $file): array
    {
        $path = self::SPEC . $file;
        if (!is_file($path)) {
            $this->markTestSkipped('The spec directory is not next to this package.');
        }

        return json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    }

    public function testEmbeddedDataStoreTablesMatchSpecDataStores(): void
    {
        // Regenerate with `composer embed-store-tables` when this fails.
        $this->assertSame($this->spec('redis.json'), Tables::redis());
        $this->assertSame($this->spec('mongodb.json'), Tables::mongodb());
        $this->assertSame($this->spec('dynamodb.json'), Tables::dynamodb());
        // Batch two: Cassandra and Cosmos DB have no PHP hook, but their tables stay in step with the spec.
        $this->assertSame($this->spec('cassandra.json'), Tables::cassandra());
        $this->assertSame($this->spec('elasticsearch.json'), Tables::elasticsearch());
        $this->assertSame($this->spec('cosmosdb.json'), Tables::cosmosdb());
        $this->assertSame($this->spec('firestore.json'), Tables::firestore());
    }

    public function testSearchClassifierPassesEverySharedElasticsearchVector(): void
    {
        $cases = $this->spec('classification-cases.json')['elasticsearch'];
        foreach ($cases as $case) {
            // The body reaches the hook as text, as a decoded document, or as a line list (NDJSON): none of them changes the answer.
            $bodies = isset($case['body']) ? [$case['body'], is_string($case['body']) ? $case['body'] : json_encode($case['body'])] : [null];
            foreach ($bodies as $body) {
                $result = Classifier::elasticsearch($case['method'], $case['path'], $body);
                $this->assertSame($case['expect'], $result['kind']->value, $case['method'] . ' ' . $case['path']);
                $this->assertSame($case['operation'], $result['operation'], $case['method'] . ' ' . $case['path']);
            }
        }
        $this->assertGreaterThan(60, count($cases));
    }

    public function testFirestoreClassifierPassesEverySharedVector(): void
    {
        $cases = $this->spec('classification-cases.json')['firestore'];
        foreach ($cases as $case) {
            if (isset($case['rest'])) {
                $rpc = Classifier::firestoreRpcFromRest($case['rest']['method'], $case['rest']['path']);
                $result = Classifier::firestore($rpc, $case['rest']['body'] ?? null);
            } else {
                $message = $case['message'] ?? null;
                foreach ([$message, is_array($message) ? json_decode(json_encode($message)) : $message] as $form) {
                    $result = Classifier::firestore($case['rpc'], $form);
                    $this->assertSame($case['expect'], $result['kind']->value, $case['rpc']);
                }
            }
            $this->assertSame($case['expect'], $result['kind']->value, json_encode($case));
            $this->assertSame($case['operation'], $result['operation'], json_encode($case));
        }
        $this->assertGreaterThan(30, count($cases));
    }

    public function testSqlEndpointsAreReadsOnlyForASingleReadStatement(): void
    {
        $write = fn (string $query) => Classifier::elasticsearch('POST', '/_plugins/_sql', ['query' => $query])['kind'];
        $this->assertSame(CommandKind::Read, $write('SELECT 1;'));
        $this->assertSame(CommandKind::Read, $write("SELECT 'a;b' FROM `x;y` -- done"));
        $this->assertSame(CommandKind::Read, $write("/* c */
  describe tables"));
        $this->assertSame(CommandKind::Write, $write("SELECT 'unterminated"));
        $this->assertSame(CommandKind::Write, $write('SELECT 1 /* open'));
        $this->assertSame(CommandKind::Write, $write('SELECT 1; SELECT 2'));
        $this->assertSame(CommandKind::Write, $write('DELETE FROM t'));
        $this->assertSame(CommandKind::Write, $write(''));
        $this->assertSame(CommandKind::Write, Classifier::elasticsearch('POST', '/_sql', '[1]')['kind']);
    }

    public function testTheClassifiersPassEverySharedClassificationVector(): void
    {
        $cases = $this->spec('classification-cases.json');
        $assertions = 0;
        foreach ($cases['redis'] as $case) {
            [$name, $args] = [$case['command'][0], array_slice($case['command'], 1)];
            $this->assertSame($case['expect'], Classifier::redis($name, $args)->value, $name);
            $assertions++;
        }
        foreach ($cases['mongodb'] as $case) {
            // Decode as objects too, the way command monitoring hands a command over.
            foreach ([$case['command'], json_decode(json_encode($case['command']))] as $command) {
                $result = Classifier::mongo($command);
                $this->assertSame($case['expect'], $result['kind']->value, json_encode($case['command']));
                $this->assertSame($case['refusedInTransaction'] ?? null, $result['refusedInTransaction'], json_encode($case['command']));
                $assertions++;
            }
        }
        foreach ($cases['dynamodb'] as $case) {
            $this->assertSame($case['expect'], Classifier::dynamo($case['operation'], $case['input'])->value, $case['operation'] . ' ' . json_encode($case['input']));
            $assertions++;
        }
        $this->assertGreaterThan(60, $assertions);
    }

    public function testAggregateWritingStagesAreFoundAtAnyDepth(): void
    {
        $deep = ['aggregate' => 'c', 'pipeline' => [['$facet' => ['a' => [['$lookup' => ['pipeline' => [['$unionWith' => ['coll' => 'x', 'pipeline' => [['$merge' => ['into' => 'y']]]]]]]]]]]]];
        $result = Classifier::mongo($deep);
        $this->assertSame(CommandKind::Write, $result['kind']);
        $this->assertSame('$merge', $result['refusedInTransaction']);
        // A key that merely looks like a stage as a value is not one.
        $this->assertSame(CommandKind::Read, Classifier::mongo(['aggregate' => 'c', 'pipeline' => [['$match' => ['name' => '$out']]]])['kind']);
    }

    public function testHostDeclaredReadsMatchExactNamesOnly(): void
    {
        $reads = Guard::readSet(['MYMODULE.GET'], strtoupper(...));
        $this->assertSame(CommandKind::Read, Classifier::redis('mymodule.get', ['k'], $reads));
        $this->assertSame(CommandKind::Write, Classifier::redis('MYMODULE.GETALL', ['k'], $reads));
        $this->assertSame(CommandKind::Read, Classifier::mongo(['customRead' => 1], Guard::readSet(['customread']))['kind']);
        $this->assertSame(CommandKind::Read, Classifier::dynamo('GetThing', [], Guard::readSet(['GetThing'])));
        $this->assertSame(CommandKind::Write, Classifier::dynamo('GetThings', [], Guard::readSet(['GetThing'])));
        $this->expectException(\InvalidArgumentException::class);
        Guard::readSet(['MY*']);
    }

    public function testRedactionReachesEveryDepthAndSanitizingKeepsOnlyNamesAndOperators(): void
    {
        $document = ['name' => 'a', 'profile' => ['apiKey' => 'k', 'city' => 'York'], 'list' => [['password_hash' => 'h']], 'idempotency_key' => 'i'];
        $this->assertSame(
            ['name' => 'a', 'profile' => ['apiKey' => '[REDACTED]', 'city' => 'York'], 'list' => [['password_hash' => '[REDACTED]']], 'idempotency_key' => 'i'],
            SqlRedactor::redactDeep($document),
        );
        $this->assertEquals(
            ['update' => '?', 'updates' => [['q' => ['_id' => '?'], 'u' => ['$set' => ['name' => '?']]]]],
            Guard::sanitizeDocument(['update' => 'documents', 'updates' => [['q' => ['_id' => 'x'], 'u' => ['$set' => ['name' => 'n']]]]]),
        );
    }

    public function testStoreLabelsMustBeDisplayNames(): void
    {
        $this->assertSame('catalog', Guard::storeLabel('catalog'));
        $this->assertNull(Guard::storeLabel(null));
        foreach (['mongodb://user:pw@host/db', 'host:27017', 'http://x', '', str_repeat('a', 65)] as $bad) {
            try {
                Guard::storeLabel($bad);
                $this->fail("Accepted {$bad}");
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
    }
}
