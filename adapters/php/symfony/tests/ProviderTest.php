<?php

declare(strict_types=1);

namespace TestBench\Symfony\Tests;

use Doctrine\Persistence\ManagerRegistry;
use TestBench\Symfony\Doctrine\DoctrinePreviewProvider;
use TestBench\Symfony\Tests\Entity\Widget;

final class ProviderTest extends DoctrineTestCase
{
    private function provider(): DoctrinePreviewProvider
    {
        $registry = $this->createStub(ManagerRegistry::class);
        $registry->method('getConnection')->willReturn($this->connection);

        return new DoctrinePreviewProvider($registry, $this->collector, ['default']);
    }

    public function testPreviewRollsBackAndReportsOrmChanges(): void
    {
        $session = $this->provider()->begin(null);
        $this->recorder->begin(true);

        $this->em->persist(new Widget('w1', 'Bolt', 'tok'));
        $this->em->flush();
        $this->assertSame(1, $this->rowCount());

        $session->rollback();
        $changes = $session->changes();
        $session->dispose();

        $this->assertSame(0, $this->rowCount());
        $this->assertSame(['insert', 'widgets', ['id' => 'w1']], [$changes[0]['operation'], $changes[0]['table'], $changes[0]['key']]);
        $this->assertNull($changes[0]['before']);
        $this->assertSame('Bolt', $changes[0]['after']['name']);
        $this->assertSame('[REDACTED]', $changes[0]['after']['api_token']);
    }

    public function testUpdateAndDeleteCarryBeforeAndAfterSnapshots(): void
    {
        $this->connection->executeStatement("insert into widgets (id, name) values ('w1', 'Initial')");
        $session = $this->provider()->begin(null);

        $widget = $this->em->find(Widget::class, 'w1');
        $widget->name = 'Temp';
        $this->em->flush();
        $this->em->remove($widget);
        $this->em->flush();
        $session->rollback();
        $changes = $session->changes();
        $session->dispose();

        $this->assertSame('update', $changes[0]['operation']);
        $this->assertSame('Initial', $changes[0]['before']['name']);
        $this->assertSame('Temp', $changes[0]['after']['name']);
        $this->assertSame('delete', $changes[1]['operation']);
        $this->assertNull($changes[1]['after']);
        $this->assertSame('Temp', $changes[1]['before']['name']);
        $this->assertSame('Initial', $this->connection->fetchOne('select name from widgets'));
    }

    public function testAFlushThatFailsRecordsNothing(): void
    {
        $this->connection->executeStatement("insert into widgets (id, name) values ('dup', 'x')");
        $session = $this->provider()->begin(null);

        $this->em->persist(new Widget('dup', 'again'));
        try {
            $this->em->flush();
            $this->fail('The duplicate key should fail.');
        } catch (\Throwable) {
        }
        $changes = $session->changes();
        $session->dispose();

        $this->assertSame([], $changes);
    }

    public function testCommittingThePreviewTransactionIsNeverConfirmed(): void
    {
        $session = $this->provider()->begin(null);
        $this->connection->executeStatement("insert into widgets (id, name) values ('w1', 'x')");
        $this->connection->commit();

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessageMatches('/committed or closed/');
        try {
            $session->rollback();
        } finally {
            $session->dispose();
        }
    }

    public function testNestedTransactionsAreUnwoundToTheStartingLevel(): void
    {
        $session = $this->provider()->begin(null);
        $this->connection->beginTransaction();
        $this->connection->executeStatement("insert into widgets (id, name) values ('w1', 'x')");

        $session->rollback();
        $session->dispose();

        $this->assertSame(0, $this->connection->getTransactionNestingLevel());
        $this->assertSame(0, $this->rowCount());
    }

    public function testDisposeIsSafeToRepeatAndRollsBackAnOpenSession(): void
    {
        $session = $this->provider()->begin(null);
        $this->connection->executeStatement("insert into widgets (id, name) values ('w1', 'x')");

        $session->dispose();
        $session->dispose();

        $this->assertSame(0, $this->rowCount());
        $this->assertFalse($this->collector->isActive());
    }

    public function testChangesAreCapped(): void
    {
        $session = $this->provider()->begin(null);
        for ($i = 0; $i < 205; $i++) {
            $this->em->persist(new Widget('w' . $i, 'n'));
        }
        $this->em->flush();
        $session->rollback();

        $this->assertCount(200, $session->changes());
        $this->assertTrue($session->changesTruncated());
        $session->dispose();
    }

    public function testObservationDoesNotTouchTransactions(): void
    {
        $observation = $this->provider()->beginObservation(null);
        $this->em->persist(new Widget('w1', 'Bolt'));
        $this->em->flush();

        $this->assertSame(1, $this->rowCount());
        $this->assertSame('insert', $observation->changes()[0]['operation']);
        $observation->dispose();
    }

    public function testTheDatabaseLabelNeverIncludesAPath(): void
    {
        $this->assertMatchesRegularExpression('/^testbench-symfony-.*\.sqlite$/', (string) $this->provider()->database());
        $this->assertSame('inventory', (new DoctrinePreviewProvider($this->createStub(ManagerRegistry::class), $this->collector, ['default'], 'inventory'))->database());
    }
}
