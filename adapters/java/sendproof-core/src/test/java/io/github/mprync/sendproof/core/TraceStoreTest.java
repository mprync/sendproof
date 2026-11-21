package io.github.mprync.sendproof.core;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

class TraceStoreTest {
    private final AtomicLong clock = new AtomicLong();
    private final TraceStore store = new TraceStore(Duration.ofSeconds(5), clock::get);
    private final TraceOwner alice = new TraceOwner("cookie", "alice", "");
    private final TraceOwner bob = new TraceOwner("cookie", "bob", "");

    private static ObservedTrace trace() {
        return new ObservedTrace(java.util.List.of(), java.util.List.of(), java.util.List.of(),
                new CaptureModels.CaptureTiming(0, 0, 0, 0, 0), null, null, null);
    }

    @Test
    void onlyTheOwnerCanReadAFinishedTrace() {
        var reservation = store.reserve(alice);
        reservation.complete(trace());
        assertThat(store.read(reservation.id(), alice)).isPresent();
        assertThat(store.read(reservation.id(), bob)).isEmpty();
        assertThat(store.read(java.util.UUID.randomUUID(), alice)).isEmpty();
    }

    @Test
    void tracesExpireWhenTheClockAdvances() {
        var reservation = store.reserve(alice);
        reservation.complete(trace());
        clock.addAndGet(Duration.ofSeconds(4).toNanos());
        assertThat(store.read(reservation.id(), alice)).isPresent();
        clock.addAndGet(Duration.ofSeconds(1).toNanos());
        assertThat(store.read(reservation.id(), alice)).isEmpty();
        assertThat(store.size()).isZero();
    }

    @Test
    void anOwnerKeepsEightAndTheHostThirtyTwo() {
        var first = store.reserve(alice);
        first.complete(trace());
        for (int i = 0; i < TraceStore.PER_OWNER_LIMIT; i++) {
            store.reserve(alice).complete(trace());
        }
        assertThat(store.read(first.id(), alice)).isEmpty();

        for (int i = 0; i < TraceStore.TOTAL_LIMIT + 4; i++) {
            store.reserve(new TraceOwner("cookie", "user" + i, "")).complete(trace());
        }
        assertThat(store.size()).isEqualTo(TraceStore.TOTAL_LIMIT);
    }

    @Test
    void discardedReservationsReadAsMissing() {
        var reservation = store.reserve(alice);
        store.discard(reservation);
        assertThat(store.read(reservation.id(), alice)).isEmpty();
    }

    @Test
    void headerValueIsThirtyTwoHexCharacters() {
        assertThat(store.reserve(alice).headerValue()).matches("[0-9a-f]{32}");
    }
}
