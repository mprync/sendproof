<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Tests;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Sendproof\Core\Stores\PreviewTransactionControlException;

/**
 * The SQL Server rules of the Eloquent provider (spec/data-stores.md, "Transaction-control statements
 * from the handler"): the start savepoint (`SAVE TRANSACTION` and `ROLLBACK TRANSACTION`), `SET
 * IMPLICIT_TRANSACTIONS OFF` allowed and `ON` refused, and a transaction the server ended itself
 * (a deadlock victim, or an error under `XACT_ABORT ON`) refusing every later statement.
 *
 * Runs against the compose SQL Server (`docker compose -f tests/conformance/compose.yml up -d --wait
 * sqlserver`) or the server `BENCH_SQLSERVER_URL` names, in a fresh database, and needs the
 * `pdo_sqlsrv` extension; skips when either is missing.
 */
final class SqlServerTest extends TestCase
{
    private static ?string $database = null;

    /** @return array{host:string,port:int,user:string,password:string} */
    private static function server(): array
    {
        $url = parse_url((string) (getenv('BENCH_SQLSERVER_URL') ?: 'mssql://sa:BenchLocal_2026%21@127.0.0.1:51433/master?encrypt=false&trustServerCertificate=true'));

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
            $name = 'sp_laravel_' . bin2hex(random_bytes(5));
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
        parent::setUp();
    }

    protected function defineEnvironment($app): void
    {
        parent::defineEnvironment($app);
        $server = self::server();
        $app['config']->set('database.connections.sqlsrv', ['driver' => 'sqlsrv', 'host' => $server['host'], 'port' => $server['port'],
            'database' => self::$database, 'username' => $server['user'], 'password' => $server['password'], 'prefix' => '',
            'encrypt' => 'no', 'trust_server_certificate' => 'true']);
        $app['config']->set('sendproof.connections', ['sqlsrv']);
    }

    protected function defineDatabaseMigrations(): void
    {
        parent::defineDatabaseMigrations();
        $sqlsrv = DB::connection('sqlsrv');
        $sqlsrv->unprepared("IF OBJECT_ID('items') IS NOT NULL DROP TABLE items");
        $sqlsrv->unprepared('CREATE TABLE items (id VARCHAR(40) PRIMARY KEY)');
    }

    /** @return list<string> */
    private function stored(): array
    {
        // A fresh connection, so only committed rows are visible.
        return self::pdo(self::$database)->query('SELECT id FROM items ORDER BY id')->fetchAll(\PDO::FETCH_COLUMN);
    }

    public function testAPreviewRollsBackThroughItsStartSavepoint(): void
    {
        Route::middleware([RequireUser::class])->post('/items/{id}/plain', function (string $id) {
            DB::connection('sqlsrv')->insert('INSERT INTO items VALUES (?)', [$id]);
            DB::connection('sqlsrv')->unprepared("INSERT INTO items VALUES ('{$id}-2')");

            return response()->json(['id' => $id]);
        })->sendproofPreview();
        $this->signIn();

        $this->preview('/items/a/plain')->assertOk()->assertJsonPath('rolledBack', true);
        $this->assertSame([], $this->stored());
    }

    public function testSetImplicitTransactionsOffIsAllowedAndOnIsRefused(): void
    {
        Route::middleware([RequireUser::class])->post('/items/{id}/off', function (string $id) {
            DB::connection('sqlsrv')->unprepared('SET IMPLICIT_TRANSACTIONS OFF'); // EF Core sends this; it leaves the transaction alone
            DB::connection('sqlsrv')->insert('INSERT INTO items VALUES (?)', [$id]);

            return response()->json(['id' => $id]);
        })->sendproofPreview();
        Route::middleware([RequireUser::class])->post('/items/{id}/on', function (string $id) {
            DB::connection('sqlsrv')->insert('INSERT INTO items VALUES (?)', [$id]);
            try {
                DB::connection('sqlsrv')->unprepared('SET NOCOUNT ON, IMPLICIT_TRANSACTIONS ON');
            } catch (PreviewTransactionControlException) {
                // Caught: the Preview still answers 500.
            }

            return response()->json(['id' => $id]);
        })->sendproofPreview();
        $this->signIn();

        $this->preview('/items/a/off')->assertOk()->assertJsonPath('rolledBack', true);
        $response = $this->preview('/items/b/on')->assertStatus(500);
        $this->assertNotTrue($response->json('rolledBack'));
        $this->assertSame([], $this->stored());
    }

    /** @return array<string,array{string}> */
    public static function escapes(): array
    {
        return ['COMMIT TRAN' => ['COMMIT TRAN'], 'ROLLBACK TRANSACTION' => ['ROLLBACK TRANSACTION'], 'BEGIN TRAN' => ['BEGIN TRAN'],
            'the reserved savepoint' => ['ROLLBACK TRANSACTION sendproof_preview'], 'SAVE TRANSACTION of the reserved name' => ['SAVE TRANSACTION sendproof_preview']];
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('escapes')]
    public function testAStatementThatEndsTheTransactionIsRefusedBeforeSending(string $sql): void
    {
        Route::middleware([RequireUser::class])->post('/items/{id}/escape', function (string $id) use ($sql) {
            DB::connection('sqlsrv')->insert('INSERT INTO items VALUES (?)', [$id]);
            try {
                DB::connection('sqlsrv')->unprepared($sql);
            } catch (PreviewTransactionControlException) {
                // Caught: the Preview still answers 500.
            }

            return response()->json(['id' => $id]);
        })->sendproofPreview();
        $this->signIn();

        $response = $this->preview('/items/a/escape')->assertStatus(500);
        $this->assertNotTrue($response->json('rolledBack'));
        $this->assertSame([], $this->stored());
    }

    /**
     * A commit around every guard (on the PDO itself) erases the start savepoint. With `IMPLICIT_TRANSACTIONS
     * ON` the next statement opens a new transaction and `@@TRANCOUNT` reads 1 again, so only the savepoint
     * proves the Preview transaction is gone.
     */
    public function testAPreviewWhoseTransactionWasCommittedAnywayIsNeverConfirmed(): void
    {
        Route::middleware([RequireUser::class])->post('/items/{id}/around', function (string $id) {
            $pdo = DB::connection('sqlsrv')->getPdo(); // the PDO itself, around every guard
            $pdo->exec("INSERT INTO items VALUES ('{$id}')");
            $pdo->exec('SET IMPLICIT_TRANSACTIONS ON');
            $pdo->exec('COMMIT TRANSACTION');
            $pdo->exec("INSERT INTO items VALUES ('{$id}-after')"); // a new transaction opens

            return response()->json(['id' => $id]);
        })->sendproofPreview();
        $this->signIn();

        $response = $this->preview('/items/escaped/around')->assertStatus(500);
        $this->assertNotTrue($response->json('rolledBack'));
        $this->assertSame(['escaped'], $this->stored());
        self::pdo(self::$database)->exec('SET IMPLICIT_TRANSACTIONS OFF');
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
    #[\PHPUnit\Framework\Attributes\DataProvider('statementPaths')]
    public function testAnErrorUnderXactAbortRefusesEveryLaterStatementInThePreview(bool $unprepared): void
    {
        DB::connection('sqlsrv')->insert("INSERT INTO items VALUES ('dup')");
        $seen = new \ArrayObject();
        Route::middleware([RequireUser::class])->post('/items/abort', function () use ($seen, $unprepared) {
            $sqlsrv = DB::connection('sqlsrv');
            $sqlsrv->unprepared('SET XACT_ABORT ON');
            try {
                $duplicate = "INSERT INTO items VALUES ('dup')";
                $unprepared ? $sqlsrv->unprepared($duplicate) : $sqlsrv->insert($duplicate);
            } catch (\Illuminate\Database\QueryException $error) {
                $seen['code'] = $error->errorInfo[1] ?? null; // the handler still gets the original error
            }
            try {
                $sqlsrv->insert("INSERT INTO items VALUES ('retry')"); // the handler's retry
            } catch (PreviewTransactionControlException) {
                $seen['refused'] = true;
            }

            return response()->json(['ok' => true]);
        })->sendproofPreview();
        $this->signIn();

        try {
            $response = $this->preview('/items/abort')->assertStatus(500);
        } finally {
            DB::connection('sqlsrv')->unprepared('SET XACT_ABORT OFF');
        }
        $this->assertNotTrue($response->json('rolledBack'));
        $this->assertSame(2627, $seen['code'] ?? null);
        $this->assertNotContains('retry', $this->stored());
        $this->assertTrue($seen['refused'] ?? false, 'The retry must be refused before it is sent.');
    }

    /**
     * A deadlock victim (1205) rolls back the whole Preview transaction. The Preview is made the victim
     * with `DEADLOCK_PRIORITY LOW`, against a second process that holds the row the Preview wants.
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('statementPaths')]
    public function testADeadlockVictimRefusesEveryLaterStatementInThePreview(bool $unprepared): void
    {
        DB::connection('sqlsrv')->insert("INSERT INTO items VALUES ('a'), ('b')");
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
        $seen = new \ArrayObject();
        Route::middleware([RequireUser::class])->post('/items/deadlock', function () use ($pipes, $seen, $unprepared) {
            $sqlsrv = DB::connection('sqlsrv');
            $sqlsrv->unprepared('SET DEADLOCK_PRIORITY LOW');
            $sqlsrv->unprepared('SET LOCK_TIMEOUT 20000');
            $sqlsrv->update("UPDATE items SET id = id WHERE id = 'a'");
            fgets($pipes[1]); // the other process holds 'b'
            try {
                // The other process now waits on 'a'; asking for 'b' closes the cycle.
                $locking = "UPDATE items SET id = id WHERE id = 'b'";
                $unprepared ? $sqlsrv->unprepared($locking) : $sqlsrv->update($locking);
            } catch (\Illuminate\Database\QueryException $error) {
                $seen['code'] = $error->errorInfo[1] ?? null; // the handler still gets the original error
            }
            try {
                $sqlsrv->insert("INSERT INTO items VALUES ('retry')"); // the handler's retry
            } catch (PreviewTransactionControlException) {
                $seen['refused'] = true;
            }

            return response()->json(['ok' => true]);
        })->sendproofPreview();
        $this->signIn();

        try {
            $response = $this->preview('/items/deadlock')->assertStatus(500);
        } finally {
            fclose($pipes[1]);
            fclose($pipes[2]);
            proc_close($other);
        }
        $this->assertNotTrue($response->json('rolledBack'));
        $this->assertSame(1205, $seen['code'] ?? null);
        $this->assertNotContains('retry', $this->stored());
        $this->assertTrue($seen['refused'] ?? false, 'The retry must be refused before it is sent.');
    }
}
