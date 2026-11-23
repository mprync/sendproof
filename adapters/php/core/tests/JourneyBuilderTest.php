<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use PHPUnit\Framework\TestCase;
use Sendproof\Core\JourneyFiles;
use Sendproof\Core\Journeys\JourneyDocument;
use Sendproof\Core\Journeys\MatchValue;
use Sendproof\Core\Journeys\Ref;
use Sendproof\Core\Journeys\StepWrites;

final class JourneyBuilderTest extends TestCase
{
    private const FIXTURE = __DIR__ . '/../../examples/journeys/';

    public function testCodeDefinitionsMatchTheConformanceDocuments(): void
    {
        $journeys = new JourneyFiles([]);
        $this->register($journeys, require self::FIXTURE . 'conformance.php');

        foreach (['conformance.arazzo.json', 'conformance.expect.json'] as $file) {
            self::assertJsonStringEqualsJsonFile(self::FIXTURE . $file, $journeys->json($file, ''));
        }
        self::assertSame('code', $journeys->discovery('/tenant')[0]['source']);
        self::assertStringContainsString('"/tenant/openapi/v1.json"', $journeys->json('conformance.arazzo.json', '/tenant'));
    }

    public function testWritesEffectsAndApprovalsUseTheSharedExpectationsShape(): void
    {
        $document = new JourneyDocument('checkout', 'Checkout journeys');
        $journey = $document->journey('checkout')
            ->group('Orders')
            ->runAs('operator@example.test')
            ->definedIn(self::class)
            ->inputs(['type' => 'object', 'properties' => ['id' => ['type' => 'string']], 'required' => ['id']]);
        $lookup = $journey->step('lookup', 'readItem')->set('id', Ref::input('id'))->output('name', '/name')->succeedsWith(200);
        $journey->step('readAgain', 'readItem')
            ->set('id', Ref::input('id'))
            ->body(['previous' => $lookup->ref('name')])
            ->runAs('customer@example.test')
            ->expectWrites(static fn (StepWrites $writes) => $writes
                ->sql('sqlite', 'items', 'update', ['name' => MatchValue::changed($lookup->ref('name'), 'Final')], ['id' => Ref::input('id')])
                ->mongo('items', 'insert', ['_id' => MatchValue::any('uuid')])
                ->redis('counter', 'incr')
                ->email('customer@example.test', MatchValue::pattern('Order #')))
            ->approvedDifference('AD-1', ['store' => 'sqlite', 'table' => 'items', 'field' => 'name'], 'Final', 'Ready', 'Labels changed.', 'reviewer@example.test', '2026-11-01');

        $files = new JourneyFiles([self::FIXTURE . 'conformance.arazzo.json']);
        $this->register($files, $document);
        self::assertSame(['file', 'code'], array_column($files->discovery(''), 'source'));

        $arazzo = json_decode($files->json('checkout.arazzo.json', ''), true, flags: JSON_THROW_ON_ERROR);
        self::assertSame(['id'], $arazzo['workflows'][0]['inputs']['required']);
        self::assertSame(['name' => '$response.body#/name'], $arazzo['workflows'][0]['steps'][0]['outputs']);
        self::assertSame(['previous' => '$steps.lookup.outputs.name'], $arazzo['workflows'][0]['steps'][1]['requestBody']['payload']);

        $expectations = json_decode($files->json('checkout.expect.json', ''), true, flags: JSON_THROW_ON_ERROR);
        $entry = $expectations['journeys']['checkout'];
        self::assertSame('Orders', $entry['group']);
        self::assertSame(self::class, $entry['definedIn']['type']);
        self::assertTrue($entry['sendOnly']);
        self::assertStringContainsString('redis', $entry['sendOnlyReason']);
        $step = $entry['steps']['readAgain'];
        self::assertSame('customer@example.test', $step['persona']);
        self::assertSame('fail', $step['unlisted']);
        self::assertSame(['from' => '$steps.lookup.outputs.name', 'to' => 'Final'], $step['writes'][0]['values']['name']);
        self::assertSame(['id' => '$inputs.id'], $step['writes'][0]['key']);
        self::assertSame(['type' => 'uuid'], $step['writes'][1]['values']['_id']);
        self::assertSame('INCR', $step['writes'][2]['op']);
        self::assertSame(['kind' => 'email', 'to' => 'customer@example.test', 'subject' => ['pattern' => 'Order #']], $step['effects'][0]);
        self::assertSame('readAgain', $expectations['approvedDifferences'][0]['step']);
        self::assertSame('value', $expectations['approvedDifferences'][0]['kind']);
    }

    public function testStartupReportsEveryInvalidReferenceAndSkipsOnlyTheInvalidJourneyOutsideDevelopment(): void
    {
        $document = new JourneyDocument('mixed', 'Mixed journeys');
        $broken = $document->journey('broken');
        $broken->step('first', 'misspelledOperation')->body(['id' => Ref::input('missing'), 'name' => Ref::output('later', 'name')]);
        $broken->step('later', 'readItem')->output('name', '/name');
        $broken->step('last', 'readItem')->set('name', Ref::output('later', 'missing'), 'query');
        $document->journey('valid')->step('read', 'readItem');

        $files = new JourneyFiles([]);
        try {
            $this->register($files, $document);
            self::fail('Development startup accepted an invalid journey.');
        } catch (\InvalidArgumentException $error) {
            self::assertStringContainsString('Unknown operationId misspelledOperation', $error->getMessage());
            self::assertStringContainsString('Unknown input missing', $error->getMessage());
            self::assertStringContainsString('Invalid step output reference $steps.later.outputs.name', $error->getMessage());
            self::assertStringContainsString('Invalid step output reference $steps.later.outputs.missing', $error->getMessage());
            self::assertSame([], $files->discovery(''));
        }

        $warnings = [];
        $openApi = require self::FIXTURE . 'openapi.php';
        $files->addJourneys($document, '/openapi/v1.json', $openApi(), false, static function (string $warning) use (&$warnings): void {
            $warnings[] = $warning;
        });
        self::assertCount(4, $warnings);
        $arazzo = json_decode($files->json('mixed.arazzo.json', ''), true, flags: JSON_THROW_ON_ERROR);
        self::assertSame(['valid'], array_column($arazzo['workflows'], 'workflowId'));
    }

    private function register(JourneyFiles $files, JourneyDocument $document): void
    {
        $openApi = require self::FIXTURE . 'openapi.php';
        $files->addJourneys($document, '/openapi/v1.json', $openApi(), true, self::fail(...));
    }
}
