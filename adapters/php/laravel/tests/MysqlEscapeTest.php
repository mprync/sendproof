<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Tests;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Sendproof\Core\Stores\PreviewTransactionControlException;

/**
 * MySQL transaction escapes through the Eloquent provider (spec/data-stores.md, "Transaction-control
 * statements from the handler"): `CALL` is refused unless the procedure is declared safe, DDL never
 * reaches the server, and a Preview whose transaction was committed anyway is never confirmed.
 *
 * Runs against the compose MySQL (`docker compose -f tests/conformance/compose.yml up -d --wait mysql`)
 * or the server `BENCH_MYSQL_URL` names, in a fresh database; skips when no server answers.
 */
final class MysqlEscapeTest extends TestCase
{
    private static ?string $database = null;

    /** @return array{host:string,port:int,user:string,password:string}|null */
    private static function server(): ?array
    {
        $url = parse_url((string) (getenv('BENCH_MYSQL_URL') ?: 'mysql://root:bench_local@127.0.0.1:53306/mysql'));
        if (!is_array($url)) {
            return null;
        }

        return ['host' => $url['host'] ?? '127.0.0.1', 'port' => (int) ($url['port'] ?? 3306),
            'user' => rawurldecode($url['user'] ?? 'root'), 'password' => rawurldecode($url['pass'] ?? '')];
    }

    private static function admin(): \PDO
    {
        $server = self::server() ?? throw new \RuntimeException('BENCH_MYSQL_URL is not a URL');

        return new \PDO("mysql:host={$server['host']};port={$server['port']}", $server['user'], $server['password'],
            [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION, \PDO::ATTR_TIMEOUT => 2]);
    }

    public static function setUpBeforeClass(): void
    {
        try {
            $name = 'sp_laravel_' . bin2hex(random_bytes(5));
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
        parent::setUp();
    }

    protected function defineEnvironment($app): void
    {
        parent::defineEnvironment($app);
        $server = self::server();
        $app['config']->set('database.connections.mysql', ['driver' => 'mysql', 'host' => $server['host'], 'port' => $server['port'],
            'database' => self::$database, 'username' => $server['user'], 'password' => $server['password'], 'prefix' => '']);
        $app['config']->set('sendproof.connections', ['mysql']);
        $app['config']->set('sendproof.safe_procedures', ['reads_only']);
    }

    protected function defineDatabaseMigrations(): void
    {
        parent::defineDatabaseMigrations();
        $mysql = DB::connection('mysql');
        $mysql->statement('DROP TABLE IF EXISTS items');
        $mysql->statement('DROP TABLE IF EXISTS escape_probe');
        $mysql->statement('CREATE TABLE items (id VARCHAR(40) PRIMARY KEY)');
        $mysql->unprepared('DROP PROCEDURE IF EXISTS commits');
        $mysql->unprepared('CREATE PROCEDURE commits() BEGIN COMMIT; END');
        $mysql->unprepared('DROP PROCEDURE IF EXISTS reads_only');
        $mysql->unprepared('CREATE PROCEDURE reads_only() BEGIN SELECT 1; END');
    }

    /** @return list<string> */
    private function stored(): array
    {
        // A fresh connection, so only committed rows are visible.
        $pdo = self::admin();

        return $pdo->query('SELECT id FROM ' . self::$database . '.items ORDER BY id')->fetchAll(\PDO::FETCH_COLUMN);
    }

    /** @return array<string,array{string}> */
    public static function escapes(): array
    {
        return ['CALL' => ['CALL commits()'], 'DDL' => ['CREATE TABLE escape_probe (n INT)'], 'executable comment' => ['/*!50000 COMMIT */'],
            'the reserved savepoint' => ['RELEASE SAVEPOINT sendproof_preview']];
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('escapes')]
    public function testAStatementThatCommitsImplicitlyIsRefusedBeforeSending(string $sql): void
    {
        Route::middleware([RequireUser::class])->post('/items/{id}/escape', function (string $id) use ($sql) {
            $mysql = DB::connection('mysql');
            $mysql->insert('INSERT INTO items VALUES (?)', [$id]);
            $mysql->select('CALL reads_only()'); // declared safe: allowed
            try {
                $mysql->unprepared($sql);
            } catch (PreviewTransactionControlException) {
                // Caught: the Preview still answers 500.
            }

            return response()->json(['id' => $id]);
        })->sendproofPreview();
        $this->signIn();

        $response = $this->preview('/items/a/escape')->assertStatus(500);
        $this->assertNotTrue($response->json('rolledBack'));
        $this->assertSame([], $this->stored());
        $this->assertSame(0, (int) self::admin()->query("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '" . self::$database . "' AND table_name = 'escape_probe'")->fetchColumn());
    }

    /**
     * With autocommit off (a driver or handler that turns it off), MySQL opens a new transaction by
     * itself after a commit, so `PDO::inTransaction()` and a savepoint made at the end both report the
     * Preview transaction as open. Only the savepoint made when the Preview began shows it is gone.
     */
    public function testAPreviewWhoseTransactionWasCommittedAnywayIsNeverConfirmed(): void
    {
        Route::middleware([RequireUser::class])->post('/items/{id}/around', function (string $id) {
            $pdo = DB::connection('mysql')->getPdo(); // the PDO itself, around every guard
            $pdo->exec("INSERT INTO items VALUES ('{$id}')");
            $pdo->exec('SET autocommit = 0');
            $pdo->exec('COMMIT');
            $pdo->exec("INSERT INTO items VALUES ('{$id}-after')"); // a new transaction opens

            return response()->json(['id' => $id]);
        })->sendproofPreview();
        $this->signIn();

        $response = $this->preview('/items/escaped/around')->assertStatus(500);
        $this->assertNotTrue($response->json('rolledBack'));
        $this->assertSame(['escaped'], $this->stored());
    }

    /**
     * A deadlock (1213) rolls back the whole Preview transaction, and PDO runs MySQL with autocommit on
     * outside `BEGIN`, so a retry would commit for real. Every later statement in the Preview is refused
     * before sending, and it answers 500; the handler still gets the original error.
     */
    /** @return array<string,array{bool}> */
    public static function deadlockPaths(): array
    {
        return ['a prepared statement' => [false], 'an unprepared statement' => [true]];
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('deadlockPaths')]
    public function testADeadlockRefusesEveryLaterStatementInThePreview(bool $unprepared): void
    {
        DB::connection('mysql')->insert("INSERT INTO items VALUES ('a'), ('b')");
        $server = self::server();
        $other = new \mysqli($server['host'], $server['user'], $server['password'], self::$database, $server['port']);
        $other->begin_transaction();
        // More locks than the Preview holds, so InnoDB picks the Preview as the deadlock victim.
        $other->query("SELECT id FROM items WHERE id = 'b' FOR UPDATE")->free();
        for ($n = 0; $n < 10; $n++) {
            $other->query("INSERT INTO items VALUES ('f{$n}')");
        }
        $seen = new \ArrayObject();
        Route::middleware([RequireUser::class])->post('/items/deadlock', function () use ($other, $seen, $unprepared) {
            $mysql = DB::connection('mysql');
            $mysql->select("SELECT id FROM items WHERE id = 'a' FOR UPDATE");
            $other->query("SELECT id FROM items WHERE id = 'a' FOR UPDATE", MYSQLI_ASYNC); // waits on the Preview's row
            usleep(300_000);
            try {
                $locking = "UPDATE items SET id = id WHERE id = 'b'";
                $unprepared ? $mysql->unprepared($locking) : $mysql->update($locking);
            } catch (\Illuminate\Database\QueryException $error) {
                $seen['code'] = $error->errorInfo[1] ?? null; // the handler still gets the original error
            }
            $other->reap_async_query();
            $other->commit();
            try {
                $mysql->insert("INSERT INTO items VALUES ('retry')"); // the handler's retry
            } catch (PreviewTransactionControlException) {
                $seen['refused'] = true;
            }

            return response()->json(['ok' => true]);
        })->sendproofPreview();
        $this->signIn();

        try {
            $response = $this->preview('/items/deadlock')->assertStatus(500);
        } finally {
            $other->close();
        }
        $this->assertNotTrue($response->json('rolledBack'));
        $this->assertSame(1213, $seen['code'] ?? null);
        $this->assertNotContains('retry', $this->stored());
        $this->assertTrue($seen['refused'] ?? false, 'The retry must be refused before it is sent.');
    }

    /**
     * Sendproof sees a deadlock through its own statement class. A MySQL connection with the app's own
     * statement class would let a retry after a deadlock commit for real, so Preview refuses to start on
     * it (409 before the handler runs) and capabilities say why.
     */
    public function testAMysqlConnectionWithItsOwnStatementClassRefusesPreview(): void
    {
        DB::connection('mysql')->getPdo()->setAttribute(\PDO::ATTR_STATEMENT_CLASS, [AppStatement::class, []]);
        Route::middleware([RequireUser::class])->post('/items/{id}/plain', function (string $id) {
            DB::connection('mysql')->insert('INSERT INTO items VALUES (?)', [$id]);

            return response()->json(['id' => $id]);
        })->sendproofPreview();
        $this->signIn();

        try {
            $response = $this->preview('/items/a/plain')->assertStatus(409);
            $this->assertStringContainsString('statement class', (string) $response->json('title'));
            $this->assertSame([], $this->stored(), 'The handler never ran.');
            $capabilities = $this->getJson('/sendproof/_api/capabilities')->json();
            $this->assertNotContains(['method' => 'POST', 'path' => '/items/{id}/plain'], $capabilities['previewOperations'] ?? []);
            $reasons = array_column(array_filter($capabilities['previewUnavailable'], static fn (array $entry): bool => $entry['path'] === '/items/{id}/plain'), 'reason');
            $this->assertCount(1, $reasons);
            $this->assertStringContainsString('statement class', $reasons[0]);
            // Reached without the middleware, the provider fails closed too and leaves no transaction open.
            try {
                $this->app->make(\Sendproof\Laravel\Eloquent\EloquentPreviewProvider::class)->begin(null);
                $this->fail('The Preview must not start.');
            } catch (\RuntimeException $error) {
                $this->assertStringContainsString('statement class', $error->getMessage());
            }
            $this->assertSame(0, DB::connection('mysql')->transactionLevel());
        } finally {
            DB::connection('mysql')->getPdo()->setAttribute(\PDO::ATTR_STATEMENT_CLASS, [\PDOStatement::class]);
        }
    }

    public function testASafeProcedureMustBeAnExactName(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->app['config']->set('sendproof.safe_procedures', ['reads_*']);
        $this->app->make(\Sendproof\Laravel\Eloquent\EloquentPreviewProvider::class);
    }
}

/** An application's own statement class, as some apps configure through `PDO::ATTR_STATEMENT_CLASS`. */
class AppStatement extends \PDOStatement
{
    protected function __construct()
    {
    }
}
