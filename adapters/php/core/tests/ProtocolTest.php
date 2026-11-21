<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Sendproof\Core\Capabilities;
use Sendproof\Core\Protocol;

final class ProtocolTest extends TestCase
{
    public function testRequiresExactlyOneRollbackPreference(): void
    {
        $this->assertTrue(Protocol::hasExactPreference(['tx=rollback']));
        $this->assertTrue(Protocol::hasExactPreference([' TX=Rollback ']));
        $this->assertFalse(Protocol::hasExactPreference([]));
        $this->assertFalse(Protocol::hasExactPreference(['tx="rollback"']));
        $this->assertFalse(Protocol::hasExactPreference(['trace, tx=rollback']));
        $this->assertFalse(Protocol::hasExactPreference(['tx=rollback', 'tx=rollback']));
    }

    public function testDetectsRollbackAmongOtherPreferences(): void
    {
        $this->assertTrue(Protocol::requestsRollback(['trace, tx="rollback"']));
        $this->assertFalse(Protocol::requestsRollback(['trace']));
    }

    public function testDetectsTraceToken(): void
    {
        $this->assertTrue(Protocol::requestsTrace(['return=minimal, trace;foo=bar']));
        $this->assertFalse(Protocol::requestsTrace(['tx=rollback']));
    }

    #[DataProvider('origins')]
    public function testSameOrigin(?string $site, array $origins, bool $expected): void
    {
        $this->assertSame($expected, Protocol::isSameOrigin($site, $origins, 'http://127.0.0.1:8080'));
    }

    public static function origins(): iterable
    {
        yield 'no origin' => [null, [], true];
        yield 'same' => ['same-origin', ['http://127.0.0.1:8080'], true];
        yield 'cross-site' => ['cross-site', [], false];
        yield 'other host' => [null, ['https://elsewhere.example.test'], false];
        yield 'other port' => [null, ['http://127.0.0.1:9000'], false];
        yield 'with path' => [null, ['http://127.0.0.1:8080/x'], false];
        yield 'two origins' => [null, ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'], false];
    }

    public function testReservedOffsetFindsThePrefixOnASegmentBoundary(): void
    {
        $this->assertSame(0, Protocol::reservedOffset('/sendproof/_preview/items'));
        $this->assertSame(0, Protocol::reservedOffset('/SENDPROOF/_PREVIEW'));
        $this->assertNull(Protocol::reservedOffset('/sendproof/_preview2'));
        $this->assertNull(Protocol::reservedOffset('/items'));
    }

    #[DataProvider('targets')]
    public function testTargetValidation(string $target, bool $valid): void
    {
        $this->assertSame($valid, Protocol::isValidTarget($target));
    }

    public static function targets(): iterable
    {
        yield ['/items/12', true];
        yield ['/items?x=1', true];
        yield ['', false];
        yield ['//items', false];
        yield ['/%2e%2e/secret', false];
        yield ['/a/../b', false];
        yield ['/sendproof/_api/capabilities', false];
        yield ['/Sendproof', false];
        yield ['/a\\b', false];
        yield ["/a\nb", false];
    }

    public function testLocalUrlRules(): void
    {
        $this->assertTrue(Capabilities::isLocalUrl('/auth/sign-in'));
        $this->assertFalse(Capabilities::isLocalUrl('//evil.example'));
        $this->assertFalse(Capabilities::isLocalUrl('https://evil.example'));
        $this->assertFalse(Capabilities::isLocalUrl('/a/../b'));
    }

    public function testCapabilitiesAddsTheOpenApiDocumentAndDerivesObservedSend(): void
    {
        $capabilities = Capabilities::build('Inventory', 'local', '/openapi.json', [], [], null, ['name' => 'Alex', 'role' => null], [], []);

        $this->assertSame(1, $capabilities['protocolVersion']);
        $this->assertSame([['name' => 'Inventory', 'url' => '/openapi.json']], $capabilities['documents']);
        $this->assertSame(['name' => 'Alex'], $capabilities['identity']);
        $this->assertFalse($capabilities['observedSend']);
        $this->assertArrayNotHasKey('fieldModules', $capabilities);
    }
}
