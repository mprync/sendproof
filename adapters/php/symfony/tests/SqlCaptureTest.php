<?php

declare(strict_types=1);

namespace Sendproof\Symfony\Tests;

use Sendproof\Core\Limits;

final class SqlCaptureTest extends DoctrineTestCase
{
    /** @return list<array<string,mixed>> */
    private function sql(): array
    {
        return array_values(array_filter(array_column($this->recorder->finish()['logs'], 'sql')));
    }

    public function testNothingIsRecordedOutsideAPreview(): void
    {
        $this->connection->executeStatement("insert into widgets (id, name) values ('w1', 'x')");

        $this->assertSame([], $this->sql());
    }

    public function testPreparedStatementsKeepParameterNamesAndReportRowsAffected(): void
    {
        $this->recorder->begin(true);
        $statement = $this->connection->prepare('update widgets set name = :name where id = :id');
        $statement->bindValue('name', 'Temp');
        $statement->bindValue('id', 'missing');
        $statement->executeStatement();

        [$entry] = $this->sql();

        $this->assertSame(['name', 'id'], array_column($entry['parameters'], 'name'));
        $this->assertSame(['Temp', 'missing'], array_column($entry['parameters'], 'value'));
        $this->assertSame(0, $entry['rowsAffected']);
    }

    public function testSecretNamedParametersAreRedacted(): void
    {
        $this->recorder->begin(true);
        $statement = $this->connection->prepare('select :fixture_secret as value, :visible as other');
        $statement->bindValue('fixture_secret', 'hunter2');
        $statement->bindValue('visible', 'shown');
        $statement->executeQuery()->fetchAllAssociative();

        [$entry] = $this->sql();

        $this->assertSame([Limits::REDACTED, Limits::REDACTED], array_column($entry['parameters'], 'value'), 'a secret in a statement hides every value');
    }

    public function testStatementsMentioningSecretColumnsHideTheirValuesEvenWhenPositional(): void
    {
        $this->recorder->begin(true);
        $this->connection->executeStatement("insert into widgets (id, name, api_token) values (?, ?, ?)", ['w1', 'Bolt', 'tok-123']);

        [$entry] = $this->sql();

        $this->assertSame([Limits::REDACTED, Limits::REDACTED, Limits::REDACTED], array_column($entry['parameters'], 'value'));
    }

    public function testSavepointStatementsAreLeftOut(): void
    {
        $this->connection->setNestTransactionsWithSavepoints(true);
        $this->recorder->begin(true);
        $this->connection->beginTransaction();
        $this->connection->beginTransaction();
        $this->connection->executeStatement("insert into widgets (id, name) values ('w1', 'x')");
        $this->connection->rollBack();
        $this->connection->rollBack();

        $texts = array_column($this->sql(), 'text');

        $this->assertSame(["insert into widgets (id, name) values ('w1', 'x')"], $texts);
    }

    public function testQueriesAccumulateDatabaseTiming(): void
    {
        $this->recorder->begin(true);
        $this->connection->fetchOne('select 1');
        $this->connection->fetchOne('select 2');

        [, $queries] = $this->recorder->counters();

        $this->assertSame(2, $queries);
    }
}
