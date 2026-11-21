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
        try {
            PreviewTurns::take('||:memory:', 0.05);
            $this->fail('A second Preview must wait for the first one to end its transaction.');
        } catch (\RuntimeException $error) {
            $this->assertStringContainsString('did not run', $error->getMessage());
        }
        $session->rollback();
        PreviewTurns::take('||:memory:', 1)->release();

        // A Preview that is disposed without rolling back still hands the turn on.
        $second = $provider->begin(null);
        $second->dispose();
        PreviewTurns::take('||:memory:', 1)->release();
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
