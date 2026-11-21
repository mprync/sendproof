<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Tests;

/**
 * PDO's emulated prepares inline each bound value into the SQL text the server receives. The `Sql`
 * log is built from the query Laravel reports (its placeholders and bindings), so a secret value is
 * still a redacted parameter and never part of the logged statement. Runs against the compose MySQL.
 */
final class EmulatedPreparesTest extends TestCase
{
    private static ?string $database = null;

    protected function defineEnvironment($app): void
    {
        parent::defineEnvironment($app);
        $url = parse_url(getenv('BENCH_MYSQL_SERVER_URL') ?: 'mysql://root:bench_local@127.0.0.1:53306');
        try {
            $pdo = new \PDO(sprintf('mysql:host=%s;port=%d', $url['host'], $url['port'] ?? 3306), rawurldecode($url['user'] ?? 'root'), rawurldecode($url['pass'] ?? ''), [\PDO::ATTR_TIMEOUT => 2]);
            self::$database ??= 'laravel_emulated_' . bin2hex(random_bytes(4));
            $pdo->exec('CREATE DATABASE IF NOT EXISTS `' . self::$database . '`');
        } catch (\PDOException) {
            $this->markTestSkipped('MySQL is not answering. Start it with: docker compose -f tests/conformance/compose.yml up -d --wait mysql');
        }
        $app['config']->set('database.connections.testing', [
            'driver' => 'mysql', 'host' => $url['host'], 'port' => $url['port'] ?? 3306, 'database' => self::$database,
            'username' => rawurldecode($url['user'] ?? 'root'), 'password' => rawurldecode($url['pass'] ?? ''),
            'options' => [\PDO::ATTR_EMULATE_PREPARES => true],
        ]);
        $app['config']->set('sendproof.sql_values', true);
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$database !== null) {
            $url = parse_url(getenv('BENCH_MYSQL_SERVER_URL') ?: 'mysql://root:bench_local@127.0.0.1:53306');
            (new \PDO(sprintf('mysql:host=%s;port=%d', $url['host'], $url['port'] ?? 3306), rawurldecode($url['user'] ?? 'root'), rawurldecode($url['pass'] ?? '')))->exec('DROP DATABASE IF EXISTS `' . self::$database . '`');
        }
    }

    public function testAnInlinedSecretIsARedactedParameterNeverStatementText(): void
    {
        $this->assertTrue(\DB::connection()->getPdo()->getAttribute(\PDO::ATTR_EMULATE_PREPARES), 'The connection inlines values.');
        $this->signIn();
        $envelope = $this->preview('/widgets', ['id' => 'w-emulated', 'name' => 'Emulated'])->assertOk()->json();
        $insert = array_values(array_filter($envelope['logs'], static fn (array $log): bool => $log['level'] === 'Sql' && str_contains(strtolower($log['sql']['text'] ?? ''), 'insert into')));
        $this->assertNotEmpty($insert);
        $this->assertStringContainsString('?', $insert[0]['sql']['text']);
        $this->assertStringNotContainsString("'tok'", $insert[0]['sql']['text'], 'The secret is not inlined in the logged statement.');
        $this->assertContains('[REDACTED]', array_column($insert[0]['sql']['parameters'], 'value'));
        $this->assertStringNotContainsString('"tok"', json_encode($envelope));
    }
}
