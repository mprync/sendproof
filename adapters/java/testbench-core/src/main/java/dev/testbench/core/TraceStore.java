package dev.testbench.core;

import java.time.Duration;
import java.util.Iterator;
import java.util.LinkedList;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.LongSupplier;

/**
 * A small in-memory cache of observed-send traces. Each owner keeps at most eight traces and the host at most 32.
 * Entries expire after the retention period (five minutes by default). Missing, expired, evicted and foreign IDs are
 * indistinguishable to callers.
 */
public final class TraceStore {
    /** Traces kept per owner. */
    public static final int PER_OWNER_LIMIT = 8;
    /** Traces kept per host. */
    public static final int TOTAL_LIMIT = 32;
    /** The default retention period. */
    public static final Duration DEFAULT_RETENTION = Duration.ofMinutes(5);
    private static final Duration COMPLETION_WAIT = Duration.ofSeconds(5);

    private final Object gate = new Object();
    private final LinkedList<Reservation> entries = new LinkedList<>();
    private final long retentionNanos;
    private final LongSupplier nanoClock;

    /** Creates a store with the default retention and the system clock. */
    public TraceStore() {
        this(DEFAULT_RETENTION, System::nanoTime);
    }

    /**
     * Creates a store.
     *
     * @param retention how long a trace stays readable
     * @param nanoClock a monotonic clock; tests can advance it instead of sleeping
     */
    public TraceStore(Duration retention, LongSupplier nanoClock) {
        if (retention.isZero() || retention.isNegative()) {
            throw new IllegalArgumentException("The trace retention must be positive.");
        }
        this.retentionNanos = retention.toNanos();
        this.nanoClock = nanoClock;
    }

    /** Reserves an ID for a trace that will complete when the observed send finishes. */
    public Reservation reserve(TraceOwner owner) {
        synchronized (gate) {
            expire();
            var previous = entries.stream().filter(entry -> entry.owner.equals(owner)).limit(PER_OWNER_LIMIT).toList();
            if (previous.size() == PER_OWNER_LIMIT) {
                remove(previous.get(0));
            }
            if (entries.size() == TOTAL_LIMIT) {
                remove(entries.getFirst());
            }
            var entry = new Reservation(UUID.randomUUID(), owner, nanoClock.getAsLong());
            entries.addLast(entry);
            return entry;
        }
    }

    /**
     * Reads a trace owned by {@code owner}, waiting briefly for an in-flight send to complete.
     *
     * @return the trace, or empty when it is missing, expired, evicted, foreign, discarded or still running
     */
    public Optional<ObservedTrace> read(UUID id, TraceOwner owner) {
        CompletableFuture<ObservedTrace> result = null;
        synchronized (gate) {
            expire();
            for (Reservation entry : entries) {
                if (entry.id.equals(id) && entry.owner.equals(owner)) {
                    result = entry.result;
                    break;
                }
            }
        }
        if (result == null) {
            return Optional.empty();
        }
        try {
            return Optional.ofNullable(result.get(COMPLETION_WAIT.toMillis(), TimeUnit.MILLISECONDS));
        } catch (TimeoutException | ExecutionException error) {
            return Optional.empty();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return Optional.empty();
        }
    }

    /** Drops a reservation whose send did not complete. Readers then see a missing trace. */
    public void discard(Reservation reservation) {
        synchronized (gate) {
            remove(reservation);
        }
    }

    /** Returns how many traces are currently retained. */
    public int size() {
        synchronized (gate) {
            expire();
            return entries.size();
        }
    }

    private void expire() {
        Iterator<Reservation> iterator = entries.iterator();
        long now = nanoClock.getAsLong();
        while (iterator.hasNext()) {
            Reservation entry = iterator.next();
            if (now - entry.start >= retentionNanos) {
                iterator.remove();
                entry.result.complete(null);
            } else {
                break;
            }
        }
    }

    private void remove(Reservation entry) {
        entries.remove(entry);
        entry.result.complete(null);
    }

    /** A pending trace. Complete it with {@link #complete(ObservedTrace)} or discard it from the store. */
    public static final class Reservation {
        private final UUID id;
        private final TraceOwner owner;
        private final long start;
        private final CompletableFuture<ObservedTrace> result = new CompletableFuture<>();

        private Reservation(UUID id, TraceOwner owner, long start) {
            this.id = id;
            this.owner = owner;
            this.start = start;
        }

        /** Returns the trace ID. */
        public UUID id() {
            return id;
        }

        /** Returns the ID as 32 hexadecimal characters, the form used in {@code X-TestBench-Trace}. */
        public String headerValue() {
            return id.toString().replace("-", "");
        }

        /** Publishes the finished trace to readers. */
        public void complete(ObservedTrace trace) {
            result.complete(trace);
        }
    }
}
