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
use Sendproof\Core\Capture\Statements;
use Sendproof\Core\Stores\PreviewTransactionControlException;
use Sendproof\Symfony\Doctrine\CaptureMiddleware;
use Sendproof\Symfony\Doctrine\DoctrinePreviewProvider;
use Sendproof\Symfony\Doctrine\OrmChangeCollector;

/**
 * MySQL transaction escapes through the Doctrine provider (spec/data-stores.md, "Transaction-control
 * statements from the handler"): `CALL` is refused unless the procedure is declared safe, DDL never
 * reaches the server, and a Preview whose transaction was committed anyway is never confirmed.
 *
 * Runs against the compose MySQL (`docker compose -f tests/conformance/compose.yml up -d --wait mysql`)
 * or the server `BENCH_MYSQL_URL` names, in a fresh database; skips when no server answers.
 */
final class DoctrineMysqlTest extends TestCase
{
    private static ?string $database = null;
    private Connection $connection;
    private Recorder $recorder;
    private DoctrinePreviewProvider $provider;

    /** @return array{host:string,port:int,user:string,password:string} */
    private static function server(): array
    {
        $url = parse_url((string) (getenv('BENCH_MYSQL_URL') ?: 'mysql://root:bench_local@127.0.0.1:53306/mysql')) ?: [];

        return ['host' => $url['host'] ?? '127.0.0.1', 'port' => (int) ($url['port'] ?? 3306),
            'user' => rawurldecode($url['user'] ?? 'root'), 'password' => rawurldecode($url['pass'] ?? '')];
    }

    private static function admin(): \PDO
    {
        $server = self::server();

        return new \PDO("mysql:host={$server['host']};port={$server['port']}", $server['user'], $server['password'],
            [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION, \PDO::ATTR_TIMEOUT => 2]);
    }

    public static function setUpBeforeClass(): void
    {
        try {
            $name = 'sp_doctrine_' . bin2hex(random_bytes(5));
            self::admin()->exec("CREATE DATABASE {$name}");
            self::$database = $name;
        } catch (\Throwable) {
            self::$database = null;
        }
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$database !== null) {
            self::admin()->exec('DROP DATABASE IF EXISTS ' . self::$database);
        }
    }

    protected function setUp(): void
    {
        if (self::$database === null) {
            $this->markTestSkipped('MySQL is not running: docker compose -f tests/conformance/compose.yml up -d --wait mysql');
        }
        $this->recorder = new Recorder();
        $configuration = (new Configuration())->setMiddlewares([new CaptureMiddleware($this->recorder, true, 'test', Statements::normalizeProcedures(['reads_only']))]);
        $server = self::server();
        $this->connection = DriverManager::getConnection(['driver' => 'pdo_mysql', 'host' => $server['host'], 'port' => $server['port'],
            'user' => $server['user'], 'password' => $server['password'], 'dbname' => self::$database], $configuration);
        $this->connection->executeStatement('DROP TABLE IF EXISTS items');
        $this->connection->executeStatement('DROP TABLE IF EXISTS escape_probe');
        $this->connection->executeStatement('CREATE TABLE items (id VARCHAR(40) PRIMARY KEY)');
        $this->connection->executeStatement('DROP PROCEDURE IF EXISTS commits');
        $this->connection->executeStatement('CREATE PROCEDURE commits() BEGIN COMMIT; END');
        $this->connection->executeStatement('DROP PROCEDURE IF EXISTS reads_only');
        $this->connection->executeStatement('CREATE PROCEDURE reads_only() BEGIN SELECT 1; END');
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
        return self::admin()->query('SELECT id FROM ' . self::$database . '.items ORDER BY id')->fetchAll(\PDO::FETCH_COLUMN);
    }

    /** @return array<string,array{string}> */
    public static function escapes(): array
    {
        return ['CALL' => ['CALL commits()'], 'DDL' => ['CREATE TABLE escape_probe (n INT)'], 'executable comment' => ['/*!50000 COMMIT */'],
            'the reserved savepoint' => ['RELEASE SAVEPOINT sendproof_preview']];
    }

    #[DataProvider('escapes')]
    public function testAStatementThatCommitsImplicitlyIsRefusedBeforeSending(string $sql): void
    {
        $session = $this->provider->begin(null);
        $this->recorder->begin(true);
        try {
            $this->connection->executeStatement("INSERT INTO items VALUES ('a')");
            $this->connection->executeQuery('CALL reads_only()')->free(); // declared safe: allowed
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
        $this->assertSame(0, (int) self::admin()->query("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '" . self::$database . "' AND table_name = 'escape_probe'")->fetchColumn());
    }

    /** @return array<string,array{bool}> */
    public static function deadlockPaths(): array
    {
        return ['a prepared statement' => [false], 'an unprepared statement' => [true]];
    }

    /**
     * A deadlock (1213) rolls back the whole Preview transaction, and PDO runs MySQL with autocommit on
     * outside `BEGIN`, so a retry would commit for real. Every later statement in the Preview is refused
     * before sending; the handler still gets the original error.
     */
    #[DataProvider('deadlockPaths')]
    public function testADeadlockRefusesEveryLaterStatementInThePreview(bool $unprepared): void
    {
        $this->connection->executeStatement("INSERT INTO items VALUES ('a'), ('b')");
        $server = self::server();
        $other = new \mysqli($server['host'], $server['user'], $server['password'], self::$database, $server['port']);
        $other->begin_transaction();
        // More locks than the Preview holds, so InnoDB picks the Preview as the deadlock victim.
        $other->query("SELECT id FROM items WHERE id = 'b' FOR UPDATE")->free();
        for ($n = 0; $n < 10; $n++) {
            $other->query("INSERT INTO items VALUES ('f{$n}')");
        }
        $session = $this->provider->begin(null);
        $this->recorder->begin(true);
        $code = null;
        $refused = false;
        try {
            $this->connection->executeQuery("SELECT id FROM items WHERE id = 'a' FOR UPDATE")->free();
            $other->query("SELECT id FROM items WHERE id = 'a' FOR UPDATE", MYSQLI_ASYNC); // waits on the Preview's row
            usleep(300_000);
            try {
                // Without parameters DBAL runs the driver's exec(); with them, a prepared statement.
                $unprepared
                    ? $this->connection->executeStatement("UPDATE items SET id = id WHERE id = 'b'")
                    : $this->connection->executeStatement('UPDATE items SET id = id WHERE id = ?', ['b']);
            } catch (\Doctrine\DBAL\Exception\DeadlockException $error) {
                $code = $error->getCode(); // the handler still gets the original error
            }
            $other->reap_async_query();
            $other->commit();
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
            $other->close();
        }
        $this->assertSame(1213, $code);
        $this->assertNotContains('retry', $this->stored());
        $this->assertTrue($refused, 'The retry must be refused before it is sent.');
        $this->assertInstanceOf(PreviewTransactionControlException::class, $this->recorder->fault());
        $this->recorder->finish();
    }

    /**
     * With autocommit off, MySQL opens a new transaction by itself after a commit, so
     * `PDO::inTransaction()` and a savepoint made at the end both report the Preview transaction as
     * open. Only the savepoint made when the Preview began shows it is gone.
     */
    public function testAPreviewWhoseTransactionWasCommittedAnywayIsNeverConfirmed(): void
    {
        $session = $this->provider->begin(null);
        $this->recorder->begin(true);
        $pdo = $this->connection->getNativeConnection(); // the driver's own handle, around every guard
        $this->assertInstanceOf(\PDO::class, $pdo);
        try {
            $pdo->exec("INSERT INTO items VALUES ('escaped')");
            $pdo->exec('SET autocommit = 0');
            $pdo->exec('COMMIT');
            $pdo->exec("INSERT INTO items VALUES ('after')"); // a new transaction opens
            $this->expectException(\RuntimeException::class);
            $this->expectExceptionMessageMatches('/committed before its rollback/');
            $session->rollback();
        } finally {
            $session->dispose();
            $pdo->exec('SET autocommit = 1');
            $this->recorder->finish();
            $this->assertSame(['escaped'], $this->stored());
        }
    }
}
