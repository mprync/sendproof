<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use PHPUnit\Framework\TestCase;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Capture\SqlRedactor;
use Sendproof\Core\Limits;

final class CaptureTest extends TestCase
{
    public function testSecretNamesAreMatchedAsWholeWords(): void
    {
        $this->assertTrue(SqlRedactor::looksSecret('fixture_secret'));
        $this->assertTrue(SqlRedactor::looksSecret('passwordHash'));
        $this->assertTrue(SqlRedactor::looksSecret('api_key'));
        $this->assertFalse(SqlRedactor::looksSecret('idempotency_key'));
        $this->assertFalse(SqlRedactor::looksSecret('Monkey'));
    }

    public function testSecretStatementsHideEveryValue(): void
    {
        [$entry] = SqlRedactor::entry('select :fixture_secret, :other', [
            ['name' => 'fixture_secret', 'value' => 'hunter2'],
            ['name' => 'other', 'value' => 'visible'],
        ], true);

        $this->assertSame([Limits::REDACTED, Limits::REDACTED], array_column($entry['parameters'], 'value'));
    }

    public function testValuesAreHiddenWhenNotAllowedAndShownOtherwise(): void
    {
        [$hidden] = SqlRedactor::entry('select 1 where a = ?', [['name' => 'p0', 'value' => 'x']], false);
        [$shown] = SqlRedactor::entry('select 1 where a = ?', [['name' => 'p0', 'value' => 'x']], true, 3);

        $this->assertSame('[REDACTED]', $hidden['parameters'][0]['value']);
        $this->assertSame('x', $shown['parameters'][0]['value']);
        $this->assertSame(3, $shown['rowsAffected']);
    }

    public function testNothingIsRecordedWhileInactive(): void
    {
        $recorder = new Recorder();

        $this->assertFalse($recorder->tryRecordEffect('email', 'Ignored'));
        $this->assertFalse($recorder->tryRecordLog('Information', 'ignored'));
    }

    public function testPreviewSuppressesEffectsAndObservedSendMarksThemDelivered(): void
    {
        $recorder = new Recorder();
        $recorder->begin(true);
        $this->assertTrue($recorder->tryRecordEffect('email', 'Preview'));
        $preview = $recorder->finish();

        $recorder->begin(false);
        $this->assertFalse($recorder->tryRecordEffect('email', 'Sent'));
        $observed = $recorder->finish();

        $this->assertArrayNotHasKey('delivered', $preview['effects'][0]);
        $this->assertTrue($observed['effects'][0]['delivered']);
    }

    public function testCollectionsAreCappedAndFlagged(): void
    {
        $recorder = new Recorder();
        $recorder->begin(true);
        for ($i = 0; $i < Limits::EFFECTS + 5; $i++) {
            $recorder->tryRecordEffect('message', "effect {$i}");
        }
        for ($i = 0; $i < Limits::LOGS + 5; $i++) {
            $recorder->tryRecordLog('Information', "log {$i}");
        }
        $result = $recorder->finish();

        $this->assertCount(Limits::EFFECTS, $result['effects']);
        $this->assertCount(Limits::LOGS, $result['logs']);
        $this->assertTrue($result['effectsTruncated']);
        $this->assertTrue($result['logsTruncated']);
    }

    public function testSqlEntriesAccumulateTimingAndCarryParameters(): void
    {
        $recorder = new Recorder();
        $recorder->begin(true);
        [$sql] = SqlRedactor::entry('select 1', [], true);
        $recorder->recordSql(2.5, $sql);
        $result = $recorder->finish();

        $this->assertSame('Sql', $result['logs'][0]['level']);
        $this->assertSame([2.5, 1], array_slice($recorder->counters(), 0, 2));
    }

    public function testPayloadsAreBoundedAndJsonSafe(): void
    {
        $truncated = false;
        $payload = Limits::payload(['text' => str_repeat('é', Limits::TEXT + 1), 'when' => new \DateTimeImmutable('2026-01-02T03:04:05Z')], $truncated);

        $this->assertTrue($truncated);
        $this->assertSame(Limits::TEXT, mb_strlen($payload['text']));
        $this->assertStringStartsWith('2026-01-02T03:04:05', $payload['when']);

        $binary = false;
        $this->assertSame(base64_encode("\xff\xfe"), Limits::payload("\xff\xfe", $binary));
    }

    public function testChangesAreCapped(): void
    {
        $changes = array_fill(0, Limits::CHANGES + 1, ['operation' => 'insert', 'table' => 't', 'key' => ['id' => 1], 'before' => null, 'after' => ['id' => 1]]);
        [$kept, $truncated] = Limits::snapshotChanges($changes);

        $this->assertCount(Limits::CHANGES, $kept);
        $this->assertTrue($truncated);
    }
}
