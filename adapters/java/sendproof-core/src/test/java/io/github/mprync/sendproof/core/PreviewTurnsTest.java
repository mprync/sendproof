package io.github.mprync.sendproof.core;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/** MySQL Previews take turns: see docs/bindings/databases.md. */
class PreviewTurnsTest {

    /** A session that counts how many are open at once. */
    private static PreviewSession session(AtomicInteger open, AtomicInteger peak, boolean failClose) {
        int now = open.incrementAndGet();
        peak.accumulateAndGet(now, Math::max);
        return new PreviewSession() {
            @Override
            public List<PreviewChange> changes() {
                return List.of();
            }

            @Override
            public void rollback() {
                // Nothing to undo.
            }

            @Override
            public void close() {
                open.decrementAndGet();
                if (failClose) {
                    throw new IllegalStateException("close failed");
                }
            }
        };
    }

    @Test
    void onlyMysqlAndMariadbTakeTurns() {
        assertThat(PreviewTurns.needed("mysql")).isTrue();
        assertThat(PreviewTurns.needed("mariadb")).isTrue();
        for (String other : new String[] {"postgresql", "h2", "sqlite", "mssql", null}) {
            assertThat(PreviewTurns.needed(other)).as(String.valueOf(other)).isFalse();
        }
    }

    @Test
    void eightPreviewsOfOneProviderNeverOverlap() throws Exception {
        var turns = new PreviewTurns();
        var open = new AtomicInteger();
        var peak = new AtomicInteger();
        var done = new CountDownLatch(8);
        var failures = new ArrayList<Throwable>();
        for (int i = 0; i < 8; i++) {
            new Thread(() -> {
                try {
                    turns.acquire();
                    PreviewSession held = turns.holding(session(open, peak, false));
                    Thread.sleep(25);
                    held.rollback();
                    held.close();
                } catch (Throwable failure) {
                    synchronized (failures) {
                        failures.add(failure);
                    }
                } finally {
                    done.countDown();
                }
            }).start();
        }
        done.await();
        assertThat(failures).isEmpty();
        assertThat(peak).as("Previews that overlap deadlock InnoDB on a shared new key").hasValue(1);
    }

    @Test
    void aFailingCloseStillHandsTheTurnOnOnce() throws Exception {
        var turns = new PreviewTurns();
        turns.acquire();
        PreviewSession held = turns.holding(session(new AtomicInteger(), new AtomicInteger(), true));
        for (int i = 0; i < 2; i++) {
            try {
                held.close();
            } catch (IllegalStateException expected) {
                // The close failure still releases the turn, and a second close must not release one it no longer holds.
            }
        }
        turns.acquire(); // Does not block: the turn was handed on.
        var waiting = new Thread(turns::acquire);
        waiting.start();
        waiting.join(300);
        assertThat(waiting.isAlive()).as("the turn is a single permit").isTrue();
        turns.release();
        waiting.join();
    }
}
