<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use PHPUnit\Framework\TestCase;
use Sendproof\Core\JourneyFiles;

final class JourneyFilesTest extends TestCase
{
    private const ARAZZO = __DIR__ . '/../../examples/journeys/conformance.arazzo.json';

    public function testServesOnlyRegisteredDocumentsAndDoesNotRetainTheRequestPathBase(): void
    {
        $journeys = new JourneyFiles([self::ARAZZO]);
        $this->assertSame([[
            'name' => 'Conformance journeys',
            'source' => 'file',
            'arazzoUrl' => '/tenant/sendproof/journeys/conformance.arazzo.json',
            'expectationsUrl' => '/tenant/sendproof/journeys/conformance.expect.json',
        ]], $journeys->discovery('/tenant'));

        foreach (['/tenant', '/other', ''] as $base) {
            $arazzo = json_decode($journeys->json('conformance.arazzo.json', $base), flags: JSON_THROW_ON_ERROR);
            $this->assertSame($base . '/openapi/v1.json', $arazzo->sourceDescriptions[0]->url);
        }
        foreach (['index.js', 'other.arazzo.json', '../conformance.expect.json'] as $path) {
            $this->assertNull($journeys->json($path, '/tenant'));
        }
    }

    public function testSuppliesEmptyExpectationsWhenNoSiblingIsRegistered(): void
    {
        $stem = 'sendproof-' . bin2hex(random_bytes(8));
        $file = sys_get_temp_dir() . '/' . $stem . '.arazzo.json';
        copy(self::ARAZZO, $file);
        try {
            $journeys = new JourneyFiles([$file]);
            $expectations = json_decode($journeys->json($stem . '.expect.json', ''), flags: JSON_THROW_ON_ERROR);
            $this->assertSame('1.0', $expectations->sendproofExpectations);
            $this->assertSame($stem . '.arazzo.json', $expectations->arazzo);
            $this->assertInstanceOf(\stdClass::class, $expectations->journeys);
            $this->assertEmpty((array) $expectations->journeys);
        } finally {
            unlink($file);
        }
    }

    public function testRejectsDuplicateRegisteredNames(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('Duplicate Arazzo filename');
        new JourneyFiles([self::ARAZZO, self::ARAZZO]);
    }
}
