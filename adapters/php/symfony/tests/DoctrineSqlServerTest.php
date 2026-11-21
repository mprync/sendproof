<?php

declare(strict_types=1);

namespace Sendproof\Symfony\Tests;

use Doctrine\DBAL\Configuration;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\DriverManager;
use Doctrine\Persistence\ManagerRegistry;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Stores\PreviewTransactionControlException;
use Sendproof\Symfony\Doctrine\CaptureMiddleware;
use Sendproof\Symfony\Doctrine\DoctrinePreviewProvider;
use Sendproof\Symfony\Doctrine\OrmChangeCollector;

/**
 * The SQL Server rules of the Doctrine provider (spec/data-stores.md, "Transaction-control statements
 * from the handler"): the start savepoint (`SAVE TRANSACTION` and `ROLLBACK TRANSACTION`), `SET
 * IMPLICIT_TRANSACTIONS OFF` allowed and `ON` refused, and a transaction the server ended itself
 * (a deadlock victim, or an error under `XACT_ABORT ON`) refusing every later statement.
 *
 * Runs against the compose SQL Server (`docker compose -f tests/conformance/compose.yml up -d --wait
 * sqlserver`) or the server `BENCH_SQLSERVER_URL` names, in a fresh database, and needs the
 * `pdo_sqlsrv` extension; skips when either is missing.
 */
final class DoctrineSqlServerTest extends TestCase
{
    private static ?string $database = null;
    private Connection $connection;
    private Recorder $recorder;
    private DoctrinePreviewProvider $provider;

    /** @return array{host:string,port:int,user:string,password:string} */
    private static function server(): array
    {
        $url = parse_url((string) (getenv('BENCH_SQLSERVER_URL') ?: 'mssql://sa:BenchLocal_2026%21@127.0.0.1:51433/master?encrypt=false&trustServerCertificate=true')) ?: [];

        return ['host' => $url['host'] ?? '127.0.0.1', 'port' => (int) ($url['port'] ?? 1433),
            'user' => rawurldecode($url['user'] ?? 'sa'), 'password' => rawurldecode($url['pass'] ?? '')];
    }

    private static function pdo(?string $database = null): \PDO
    {
        $server = self::server();

        return new \PDO(
            "sqlsrv:Server={$server['host']},{$server['port']};" . ($database !== null ? "Database={$database};" : '') . 'Encrypt=no;TrustServerCertificate=yes;LoginTimeout=3',
            $server['user'], $server['password'], [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION],
        );
    }

    public static function setUpBeforeClass(): void
    {
        try {
            $name = 'sp_doctrine_' . bin2hex(random_bytes(5));
            self::pdo()->exec("CREATE DATABASE {$name}");
            self::$database = $name;
        } catch (\Throwable) {
            self::$database = null;
        }
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$database !== null) {
            self::pdo()->exec('ALTER DATABASE ' . self::$database . ' SET SINGLE_USER WITH ROLLBACK IMMEDIATE');
            self::pdo()->exec('DROP DATABASE ' . self::$database);
        }
    }

    protected function setUp(): void
    {
        if (self::$database === null) {
            $this->markTestSkipped('SQL Server (or pdo_sqlsrv) is not available: docker compose -f tests/conformance/compose.yml up -d --wait sqlserver');
        }
        $this->recorder = new Recorder();
        $configuration = (new Configuration())->setMiddlewares([new CaptureMiddleware($this->recorder, true, 'test')]);
        $server = self::server();
        $this->connection = DriverManager::getConnection(['driver' => 'pdo_sqlsrv', 'host' => $server['host'], 'port' => $server['port'],
            'user' => $server['user'], 'password' => $server['password'], 'dbname' => self::$database,
            'driverOptions' => ['Encrypt' => 'no', 'TrustServerCertificate' => 'yes']], $configuration);
        $this->connection->executeStatement("IF OBJECT_ID('items') IS NOT NULL DROP TABLE items");
        $this->connection->executeStatement('CREATE TABLE items (id VARCHAR(40) PRIMARY KEY)');
        $registry = $this->createStub(ManagerRegistry::class);
        $registry->method('getConnection')->willReturn($this->connection);
        $this->provider = new DoctrinePreviewProvider($registry, new OrmChangeCollector(), ['default']);
    }

    protected function tearDown(): void
    {
        if (isset($this->connection)) {
            $this->connection->close();
        }
    }

    /** @return list<string> */
    private function stored(): array
    {
        // A fresh connection, so only committed rows are visible.
        return self::pdo(self::$database)->query('SELECT id FROM items ORDER BY id')->fetchAll(\PDO::FETCH_COLUMN);
    }

    public function testAPreviewRollsBackThroughItsStartSavepoint(): void
    {
        $session = $this->provider->begin(null);
        $this->recorder->begin(true);
        try {
            $this->connection->executeStatement("INSERT INTO items VALUES ('a')");
            $this->connection->executeStatement('INSERT INTO items VALUES (?)', ['b']);
            $session->rollback();
        } finally {
            $session->dispose();
            $this->recorder->finish();
        }
        $this->assertSame([], $this->stored());
    }

    public function testSetImplicitTransactionsOffIsAllowedAndOnIsRefused(): void
    {
        $session = $this->provider->begin(null);
        $this->recorder->begin(true);
        try {
            $this->connection->executeStatement('SET IMPLICIT_TRANSACTIONS OFF'); // EF Core sends this; it leaves the transaction alone
            $this->connection->executeStatement("INSERT INTO items VALUES ('a')");
            try {
                $this->connection->executeStatement('SET NOCOUNT ON, IMPLICIT_TRANSACTIONS ON');
                $this->fail('IMPLICIT_TRANSACTIONS ON must be refused');
            } catch (PreviewTransactionControlException) {
                $this->assertNotNull($this->recorder->fault());
            }
            $session->rollback();
        } finally {
            $session->dispose();
            $this->recorder->finish();
        }
        $this->assertSame([], $this->stored());
    }

    /** @return array<string,array{string}> */
    public static function escapes(): array
    {
        return ['COMMIT TRAN' => ['COMMIT TRAN'], 'ROLLBACK TRANSACTION' => ['ROLLBACK TRANSACTION'], 'BEGIN TRAN' => ['BEGIN TRAN'],
            'the reserved savepoint' => ['ROLLBACK TRANSACTION sendproof_preview'], 'SAVE TRANSACTION of the reserved name' => ['SAVE TRANSACTION sendproof_preview']];
    }

    #[DataProvider('escapes')]
    public function testAStatementThatEndsTheTransactionIsRefusedBeforeSending(string $sql): void
    {
        $session = $this->provider->begin(null);
        $this->recorder->begin(true);
        try {
            $this->connection->executeStatement("INSERT INTO items VALUES ('a')");
            try {
                $this->connection->executeStatement($sql);
                $this->fail("{$sql} must be refused");
            } catch (PreviewTransactionControlException) {
                $this->assertNotNull($this->recorder->fault());
            }
            $session->rollback();
        } finally {
            $session->dispose();
            $this->recorder->finish();
        }
        $this->assertSame([], $this->stored());
    }

    /**
     * A commit around every guard (on the PDO itself) erases the start savepoint. With `IMPLICIT_TRANSACTIONS
     * ON` the next statement opens a new transaction and `@@TRANCOUNT` reads 1 again, so only the savepoint
     * proves the Preview transaction is gone.
     */
    public function testAPreviewWhoseTransactionWasCommittedAnywayIsNeverConfirmed(): void
    {
        $session = $this->provider->begin(null);
        $this->recorder->begin(true);
        $pdo = $this->connection->getNativeConnection(); // the driver's own handle, around every guard
        $this->assertInstanceOf(\PDO::class, $pdo);
        try {
            $pdo->exec("INSERT INTO items VALUES ('escaped')");
            $pdo->exec('SET IMPLICIT_TRANSACTIONS ON');
            $pdo->exec('COMMIT TRANSACTION');
            $pdo->exec("INSERT INTO items VALUES ('after')"); // a new transaction opens
            $this->expectException(\RuntimeException::class);
            $this->expectExceptionMessageMatches('/committed before its rollback/');
            $session->rollback();
        } finally {
            $session->dispose();
            $pdo->exec('SET IMPLICIT_TRANSACTIONS OFF');
            $this->recorder->finish();
            $this->assertSame(['escaped'], $this->stored());
        }
    }

    /** @return array<string,array{bool}> */
    public static function statementPaths(): array
    {
        return ['a prepared statement' => [false], 'an unprepared statement' => [true]];
    }

    /**
     * An error under `XACT_ABORT ON` rolls back the whole Preview transaction, and the connection then
     * autocommits, so a retry would commit for real. Every later statement is refused before sending.
     */
    #[DataProvider('statementPaths')]
    public function testAnErrorUnderXactAbortRefusesEveryLaterStatementInThePreview(bool $unprepared): void
    {
        $this->connection->executeStatement("INSERT INTO items VALUES ('dup')");
        $session = $this->provider->begin(null);
        $this->recorder->begin(true);
        $code = null;
        $refused = false;
        try {
            $this->connection->executeStatement('SET XACT_ABORT ON');
            try {
                // Without parameters DBAL runs the driver's exec(); with them, a prepared statement.
                $unprepared
                    ? $this->connection->executeStatement("INSERT INTO items VALUES ('dup')")
                    : $this->connection->executeStatement('INSERT INTO items VALUES (?)', ['dup']);
            } catch (\Doctrine\DBAL\Exception\UniqueConstraintViolationException $error) {
                $code = $error->getCode(); // the handler still gets the original error
            }
            try {
                $this->connection->executeStatement("INSERT INTO items VALUES ('retry')"); // the handler's retry
            } catch (PreviewTransactionControlException) {
                $refused = true;
            }
            try {
                $session->rollback();
                $this->fail('The Preview must not be confirmed.');
            } catch (\RuntimeException) {
                $this->addToAssertionCount(1);
            }
        } finally {
            $session->dispose();
            $this->connection->getNativeConnection()->exec('SET XACT_ABORT OFF'); // the guard now refuses every statement
        }
        $this->assertSame(2627, $code);
        $this->assertNotContains('retry', $this->stored());
        $this->assertTrue($refused, 'The retry must be refused before it is sent.');
        $this->assertInstanceOf(PreviewTransactionControlException::class, $this->recorder->fault());
        $this->recorder->finish();
    }

    /**
     * A deadlock victim (1205) rolls back the whole Preview transaction. The Preview is made the victim
     * with `DEADLOCK_PRIORITY LOW`, against a second process that holds the row the Preview wants.
     */
    #[DataProvider('statementPaths')]
    public function testADeadlockVictimRefusesEveryLaterStatementInThePreview(bool $unprepared): void
    {
        $this->connection->executeStatement("INSERT INTO items VALUES ('a'), ('b')");
        $server = self::server();
        $script = sprintf(
            '$p = new PDO("sqlsrv:Server=%s,%d;Database=%s;Encrypt=no;TrustServerCertificate=yes", %s, %s, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);'
            . '$p->exec("SET DEADLOCK_PRIORITY HIGH"); $p->exec("SET LOCK_TIMEOUT 20000"); $p->beginTransaction();'
            . '$p->exec("UPDATE items SET id = id WHERE id = \'b\'"); echo "ready\n"; fflush(STDOUT);'
            . '$p->exec("UPDATE items SET id = id WHERE id = \'a\'"); $p->commit(); echo "done\n";',
            $server['host'], $server['port'], self::$database, var_export($server['user'], true), var_export($server['password'], true),
        );
        $other = proc_open([PHP_BINARY, '-r', $script], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $this->assertIsResource($other);
        $session = $this->provider->begin(null);
        $this->recorder->begin(true);
        $code = null;
        $refused = false;
        try {
            $this->connection->executeStatement('SET DEADLOCK_PRIORITY LOW');
            $this->connection->executeStatement('SET LOCK_TIMEOUT 20000');
            $this->connection->executeStatement("UPDATE items SET id = id WHERE id = 'a'");
            fgets($pipes[1]); // the other process holds 'b'
            try {
                // The other process now waits on 'a'; asking for 'b' closes the cycle.
                $unprepared
                    ? $this->connection->executeStatement("UPDATE items SET id = id WHERE id = 'b'")
                    : $this->connection->executeStatement('UPDATE items SET id = id WHERE id = ?', ['b']);
            } catch (\Doctrine\DBAL\Exception\DriverException $error) {
                $code = $error->getCode(); // the handler still gets the original error
            }
            try {
                $this->connection->executeStatement("INSERT INTO items VALUES ('retry')"); // the handler's retry
            } catch (PreviewTransactionControlException) {
                $refused = true;
            }
            try {
                $session->rollback();
                $this->fail('The Preview must not be confirmed.');
            } catch (\RuntimeException) {
                $this->addToAssertionCount(1);
            }
        } finally {
            $session->dispose();
            fclose($pipes[1]);
            fclose($pipes[2]);
            proc_close($other);
        }
        $this->assertSame(1205, $code);
        $this->assertNotContains('retry', $this->stored());
        $this->assertTrue($refused, 'The retry must be refused before it is sent.');
        $this->assertInstanceOf(PreviewTransactionControlException::class, $this->recorder->fault());
        $this->recorder->finish();
    }
}
