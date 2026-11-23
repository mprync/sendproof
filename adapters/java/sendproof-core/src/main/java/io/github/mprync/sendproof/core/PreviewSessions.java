package io.github.mprync.sendproof.core;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Process-local session registry. A lease excludes every other request, including expiry and shutdown cleanup. */
public final class PreviewSessions implements AutoCloseable {
    public static final String HEADER = "Sendproof-Session";
    private static final Logger LOG = LoggerFactory.getLogger(PreviewSessions.class);
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int PER_OWNER = 4;
    private static final int PER_HOST = 16;

    private final Map<String, Session> sessions = new HashMap<>();
    private final int idleSeconds;
    private final int lifetimeSeconds;
    private final ScheduledExecutorService sweeper;
    private final LongSupplier nanoTime;
    private boolean stopped;

    public PreviewSessions() {
        this(300, 1800, System::nanoTime);
    }

    PreviewSessions(int idleSeconds, int lifetimeSeconds, LongSupplier nanoTime) {
        this.idleSeconds = idleSeconds;
        this.lifetimeSeconds = lifetimeSeconds;
        this.nanoTime = nanoTime;
        sweeper = Executors.newSingleThreadScheduledExecutor(task -> {
            var thread = new Thread(task, "sendproof-sessions");
            thread.setDaemon(true);
            return thread;
        });
        sweeper.scheduleWithFixedDelay(this::expire, 1, 1, TimeUnit.SECONDS);
    }

    /** Returns null for an authenticated caller without a stable subject. Anonymous ownership is mount-specific. */
    public static TraceOwner owner(TraceOwner authenticated, boolean signedIn, String mount) {
        return authenticated != null ? authenticated : signedIn ? null : new TraceOwner(null, null, mount);
    }

    public static boolean supported(PreviewProvider provider, List<? extends DataStore> stores) {
        try {
            return (provider != null || !stores.isEmpty())
                    && (provider == null || provider.supportsHeldPreview())
                    && stores.stream().allMatch(DataStore::supportsHeldStore);
        } catch (RuntimeException failure) {
            return false;
        }
    }

    public Opened open(TraceOwner owner, PreviewProvider provider, List<? extends DataStore> stores) {
        if (owner == null) {
            throw new Refusal(403, null, "An authenticated caller needs one stable subject to open a preview session.");
        }
        if (!supported(provider, stores)) {
            throw new Refusal(409, null, "Preview sessions are unavailable for this host's stores.");
        }
        var session = reserve(owner);
        boolean opened = false;
        try {
            if (provider != null) {
                session.parts.add(java.util.Objects.requireNonNull(provider.beginHeld()));
            }
            for (DataStore store : stores) {
                HeldPreview part = store.beginHeldStore();
                if (part != null) {
                    session.parts.add(part);
                }
            }
            synchronized (this) {
                opened = !stopped && !expired(session, nanoTime.getAsLong());
            }
        } catch (HeldPreview.StoreBusy busy) {
            throw new Refusal(409, "store_busy", "Another Preview session is holding " + CaptureLimits.clip(busy.getMessage()) + ".",
                    "That session ends by itself after its idle timeout (" + idleSeconds
                            + " seconds), or when it is ended.", idleSeconds);
        } catch (Exception failure) {
            LOG.error("A Sendproof preview session could not open.", failure);
            throw failed();
        } finally {
            if (!opened) {
                session.ending = true;
            }
            release(session);
        }
        if (!opened) {
            throw failed();
        }
        return new Opened(session.id, idleSeconds, lifetimeSeconds);
    }

    private synchronized Session reserve(TraceOwner owner) {
        if (stopped) {
            throw failed();
        }
        if (sessions.size() >= PER_HOST || sessions.values().stream().filter(s -> s.owner.equals(owner)).count() >= PER_OWNER) {
            throw new Refusal(429, "session_limit", "Too many preview sessions are open. End one first.");
        }
        var bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        var session = new Session(HexFormat.of().formatHex(bytes), owner, nanoTime.getAsLong());
        sessions.put(session.id, session);
        return session;
    }

    public Lease enter(String id, TraceOwner owner) {
        synchronized (this) {
            Session session = sessions.get(id);
            if (stopped || session == null || session.ending || !session.owner.equals(owner)
                    || expired(session, nanoTime.getAsLong())) {
                throw notFound();
            }
            if (session.busy) {
                throw new Refusal(409, "session_busy", "The preview session is serving another request.");
            }
            session.busy = true;
            return new Lease(session);
        }
    }

    private boolean expired(Session session, long now) {
        return now - session.created >= TimeUnit.SECONDS.toNanos(lifetimeSeconds)
                || (!session.busy && now - session.touched >= TimeUnit.SECONDS.toNanos(idleSeconds));
    }

    private void release(Session session) {
        synchronized (this) {
            long now = nanoTime.getAsLong();
            if (!stopped && !session.ending && !expired(session, now)) {
                session.touched = now;
                session.busy = false;
                return;
            }
            session.ending = true;
        }
        end(session);
    }

    void expire() {
        List<Session> expired;
        synchronized (this) {
            long now = nanoTime.getAsLong();
            expired = sessions.values().stream().filter(s -> !s.busy && (stopped || expired(s, now))).toList();
            expired.forEach(s -> {
                s.ending = true;
                s.busy = true;
            });
        }
        expired.forEach(this::end);
    }

    private boolean end(Session session) {
        boolean rolledBack = true;
        for (int i = session.parts.size() - 1; i >= 0; i--) {
            try {
                session.parts.get(i).close();
            } catch (Exception failure) {
                rolledBack = false;
                LOG.error("A held Preview transaction could not be rolled back.", failure);
            }
        }
        session.parts.clear();
        session.steps.clear();
        synchronized (this) {
            sessions.remove(session.id, session);
        }
        return rolledBack;
    }

    @Override
    public void close() {
        synchronized (this) {
            stopped = true;
        }
        sweeper.shutdown();
        expire();
    }

    public record Opened(String id, int idleTimeoutSeconds, int maxLifetimeSeconds) {
    }

    /** A missing, non-integer or malformed step is outside the rewind range. */
    public static int rewindStep(byte[] body) {
        try {
            var input = Json.MAPPER.readTree(body);
            var step = input == null ? null : input.get("step");
            return step != null && step.isIntegralNumber() && step.canConvertToInt() ? step.intValue() : 0;
        } catch (java.io.IOException invalid) {
            return 0;
        }
    }

    private static final class Session {
        final String id;
        final TraceOwner owner;
        final long created;
        final List<HeldPreview> parts = new ArrayList<>();
        final List<List<HeldPreview.Checkpoint>> steps = new ArrayList<>();
        long touched;
        boolean busy = true;
        volatile boolean ending;

        Session(String id, TraceOwner owner, long created) {
            this.id = id;
            this.owner = owner;
            this.created = created;
            this.touched = created;
        }
    }

    /** Serializes a Preview, rewind or end operation against other requests for the same session. */
    public final class Lease implements AutoCloseable {
        private final Session session;
        private List<HeldPreview.Checkpoint> current;
        private boolean released;

        private Lease(Session session) {
            this.session = session;
        }

        List<HeldPreview> parts() {
            return session.parts;
        }

        PreviewEnvelope.Session marker() {
            return new PreviewEnvelope.Session(session.id, session.steps.size() + 1);
        }

        void checkpoint() throws Exception {
            current = new ArrayList<>();
            try {
                for (HeldPreview part : session.parts) {
                    current.add(part.checkpoint());
                }
            } catch (Exception error) {
                session.ending = true;
                throw error;
            }
        }

        void finish(boolean keep) throws Exception {
            if (current == null || session.ending) {
                return;
            }
            if (keep) {
                session.steps.add(current);
            } else {
                try {
                    rollback(current);
                } catch (Exception error) {
                    session.ending = true;
                    throw error;
                }
            }
            current = null;
        }

        public void rewind(int step) {
            int next = session.steps.size() + 1;
            if (step < 1 || step > next) {
                throw new Refusal(400, null, "Rewind to a step from 1 to " + next + ".");
            }
            try {
                // MongoDB applies each undo in reverse order. This also works for nested SQL savepoints.
                for (int i = next - 2; i >= step - 1; i--) {
                    rollback(session.steps.remove(i));
                }
            } catch (Exception error) {
                session.ending = true;
                LOG.error("A Sendproof preview session could not rewind.", error);
                if (error instanceof HeldPreview.TransactionEnded) {
                    throw failed();
                }
                throw new Refusal(500, null, "The preview session could not be rewound and was closed.");
            }
        }

        private void rollback(List<HeldPreview.Checkpoint> points) throws Exception {
            for (int i = points.size() - 1; i >= 0; i--) {
                var point = points.get(i);
                point.rollback();
                point.discard();
            }
        }

        public void end() {
            session.ending = true;
            released = true;
            if (!PreviewSessions.this.end(session)) {
                throw new Refusal(500, null, "The preview session could not be rolled back cleanly.");
            }
        }

        void invalidate() {
            session.ending = true;
        }

        @Override
        public void close() {
            if (!released) {
                released = true;
                release(session);
            }
        }
    }

    public static Refusal notFound() {
        return new Refusal(404, "session_not_found", "The preview session was not found.");
    }

    static Refusal failed() {
        return new Refusal(409, "session_failed", "The preview session failed and was closed.");
    }

    /** A transport-neutral RFC 9457 response, shared by the session routes and both Preview pipelines. */
    public static final class Refusal extends RuntimeException {
        private final int status;
        private final Map<String, Object> problem;

        public Refusal(int status, String code, String title) {
            this(status, code, title, null, null);
        }

        private Refusal(int status, String code, String title, String detail, Integer timeout) {
            super(title);
            this.status = status;
            problem = new HashMap<>(Map.of("type", "about:blank", "status", status, "title", title));
            if (code != null) {
                problem.put("code", code);
            }
            if (detail != null) {
                problem.put("detail", detail);
            }
            if (timeout != null) {
                problem.put("idleTimeoutSeconds", timeout);
            }
        }

        public int status() {
            return status;
        }

        public Map<String, Object> problem() {
            return Map.copyOf(problem);
        }

        public PreviewOutcome outcome() {
            return new PreviewOutcome(status, getMessage(), null, null, null, Json.MAPPER.valueToTree(problem).toString()
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
    }
}
