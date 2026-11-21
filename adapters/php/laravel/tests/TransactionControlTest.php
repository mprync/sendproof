<?php

declare(strict_types=1);

namespace Sendproof\Laravel\Tests;

use Illuminate\Database\DatabaseManager;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Preview\PreviewTurns;
use Sendproof\Core\Stores\PreviewTransactionControlException;
use Sendproof\Laravel\Eloquent\ChangeCollector;
use Sendproof\Laravel\Eloquent\EloquentPreviewProvider;
use Sendproof\Laravel\Http\PreviewUnavailable;

/**
 * The transaction-control rule (spec/data-stores.md): a handler can't end the Preview transaction.
 * Also the MySQL turn a Preview takes, and the `preview: false` mark.
 */
final class TransactionControlTest extends TestCase
{
    private function mark(string $path, \Closure $handler): void
    {
        Route::middleware([RequireUser::class])->post($path, $handler)->sendproofPreview();
    }

    /** @return array<string,array{string}> */
    public static function endingStatements(): array
    {
        return ['COMMIT' => ['COMMIT'], 'END' => ['END'], 'ROLLBACK' => ['ROLLBACK'], 'BEGIN' => ['BEGIN'], 'SET autocommit' => ['SET autocommit = 1'], 'COMMIT behind a comment' => ["-- x\nCOMMIT"]];
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('endingStatements')]
    public function testAStatementThatEndsTheTransactionIsRefusedAndFailsThePreviewEvenWhenCaught(string $sql): void
    {
        $this->mark('/widgets/{id}/ends', function (string $id) use ($sql) {
            Widget::create(['id' => $id, 'name' => 'escaped']);
            try {
                DB::unprepared($sql);
            } catch (PreviewTransactionControlException) {
                // Caught: the Preview still answers 500.
            }

            return response()->json(['id' => $id]);
        });
        $this->signIn();

        $response = $this->preview('/widgets/w1/ends')->assertStatus(500);
        $this->assertNotTrue($response->json('rolledBack'));
        $this->assertSame(0, $this->widgetCount(), 'Nothing is persisted.');
    }

    public function testAnUnbalancedDbCommitIsRefusedBeforeItCommitsThePreviewTransaction(): void
    {
        $this->mark('/widgets/{id}/commit-api', function (string $id) {
            Widget::create(['id' => $id, 'name' => 'escaped']);
            DB::commit();

            return response()->json(['id' => $id]);
        });
        $this->signIn();

        $this->preview('/widgets/w1/commit-api')->assertStatus(500);
        $this->assertSame(0, $this->widgetCount());
    }

    /**
     * The start-savepoint backstop on every database: a commit on the PDO itself, then a new transaction,
     * would let a plain rollback succeed. The savepoint made when the Preview began is gone, so it answers 500.
     */
    public function testAPreviewCommittedOnThePdoItselfIsNeverConfirmed(): void
    {
        $this->mark('/widgets/{id}/around', function (string $id) {
            Widget::create(['id' => $id, 'name' => 'escaped']);
            $pdo = DB::connection()->getPdo(); // around every guard
            $pdo->exec('COMMIT');
            $pdo->exec('BEGIN');
            $pdo->exec("INSERT INTO widgets (id, name) VALUES ('{$id}-after', 'after')");

            return response()->json(['id' => $id]);
        });
        $this->signIn();

        $response = $this->preview('/widgets/w1/around')->assertStatus(500);
        $this->assertNotTrue($response->json('rolledBack'));
        $this->assertSame(1, $this->widgetCount(), 'The write before the commit stays; the Preview never claims otherwise.');
    }

    public function testAHandlerMayNotReleaseThePreviewSavepoint(): void
    {
        $this->mark('/widgets/{id}/release', function (string $id) {
            Widget::create(['id' => $id, 'name' => 'x']);
            try {
                DB::unprepared('RELEASE SAVEPOINT sendproof_preview');
            } catch (PreviewTransactionControlException) {
                // Caught: the Preview still answers 500.
            }

            return response()->json(['id' => $id]);
        });
        $this->signIn();

        $this->preview('/widgets/w1/release')->assertStatus(500);
        $this->assertSame(0, $this->widgetCount());
    }

    public function testSavepointsAndNestedTransactionsStayAllowed(): void
    {
        $this->signIn();
        $this->preview('/widgets/w1/nested')->assertOk();
    }

    public function testASendOrObservedSendMayCommitNormally(): void
    {
        $this->mark('/widgets/{id}/commit-send', function (string $id) {
            DB::transaction(fn () => Widget::create(['id' => $id, 'name' => 'sent']));

            return response()->json(['id' => $id]);
        });
        $this->signIn();

        $this->json('POST', '/widgets/w1/commit-send', [], ['Prefer' => 'trace'])->assertOk();
        $this->assertSame(1, $this->widgetCount());
    }

    public function testAMysqlPreviewHoldsItsDatabaseTurnUntilItsTransactionEnds(): void
    {
        $recorder = new Recorder();
        $provider = new class($this->app->make(DatabaseManager::class), $this->app->make(ChangeCollector::class), [null], null, fn () => $recorder) extends EloquentPreviewProvider {
            /** SQLite stands in for MySQL here: the turn is the same whatever database holds it. */
            protected function takesTurns(\Illuminate\Database\Connection $connection): bool
            {
                return true;
            }
        };

        $session = $provider->begin(null);
        $this->assertStringContainsString('did not run', $this->takeElsewhere(0.05), 'A second Preview, in another worker process, must wait for the first one to end its transaction.');
        $session->rollback();
        $this->assertSame('took', $this->takeElsewhere(1));

        // A Preview that is disposed without rolling back still hands the turn on.
        $second = $provider->begin(null);
        $second->dispose();
        $this->assertSame('took', $this->takeElsewhere(1));
    }

    /** Takes the in-memory database's turn from another process, as another worker would; returns what it printed. */
    private function takeElsewhere(float $timeoutSeconds): string
    {
        $code = sprintf('require %s; try { Sendproof\Core\Preview\PreviewTurns::take("||:memory:", %F)->release(); echo "took"; } catch (RuntimeException $e) { echo $e->getMessage(); }', var_export(realpath(__DIR__ . '/../vendor/autoload.php'), true), $timeoutSeconds);

        return (string) shell_exec(escapeshellarg(PHP_BINARY) . ' -r ' . escapeshellarg($code));
    }

    public function testAnApplicationWithNoMysqlTakesNoTurn(): void
    {
        $session = $this->app->make(EloquentPreviewProvider::class)->begin(null);
        $turn = PreviewTurns::take('||:memory:', 0.05);
        $this->assertInstanceOf(\Sendproof\Core\Preview\PreviewTurn::class, $turn, 'SQLite Previews do not queue on a turn: the database serialises them itself.');
        $turn->release();
        $session->rollback();
    }

    public function testThePreviewFalseMarkNeedsAReasonOrAStoreAndIsNeverInferred(): void
    {
        $this->assertSame('Preview unavailable: this operation writes to Redis', PreviewUnavailable::decode(PreviewUnavailable::using(null, ['redis']))['reason']);
        $this->assertSame(['reason' => 'Clears the cache, then some', 'stores' => ['redis']], PreviewUnavailable::decode(PreviewUnavailable::using('Clears the cache, then some', ['redis'])));
        foreach ([[null, []], ['', []], [str_repeat('x', 513), []], [null, ['Redis']]] as [$reason, $stores]) {
            try {
                PreviewUnavailable::using($reason, $stores);
                $this->fail('An unusable mark must be refused.');
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }

        Route::middleware([RequireUser::class])->post('/widgets/{id}/marked', fn () => response()->json(['ran' => true]))->sendproofPreview(false, 'Sends a real email');
        $this->signIn();
        $capabilities = $this->getJson('/sendproof/_api/capabilities')->json();
        $this->assertSame([['method' => 'POST', 'path' => '/widgets/{id}/marked', 'reason' => 'Sends a real email']], $capabilities['previewUnavailable']);
        $this->assertNotContains(['method' => 'POST', 'path' => '/widgets/{id}/marked'], $capabilities['previewOperations']);
        $this->preview('/widgets/w1/marked')->assertStatus(409);
        // Without the mark an operation that touches a store stays advertised: the binding never infers it.
        $this->assertContains(['method' => 'POST', 'path' => '/widgets'], $capabilities['previewOperations']);
    }
}
