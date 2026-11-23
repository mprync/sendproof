package io.github.mprync.sendproof.mongodb;

import com.fasterxml.jackson.databind.JsonNode;
import com.mongodb.MongoCommandException;
import com.mongodb.MongoNamespace;
import com.mongodb.event.CommandFailedEvent;
import com.mongodb.event.CommandListener;
import com.mongodb.event.CommandStartedEvent;
import com.mongodb.event.CommandSucceededEvent;
import io.github.mprync.sendproof.core.BlockedWrite;
import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.DataStore;
import io.github.mprync.sendproof.core.DbEntry;
import io.github.mprync.sendproof.core.Json;
import io.github.mprync.sendproof.core.PreviewChange;
import io.github.mprync.sendproof.core.RequestCapture;
import io.github.mprync.sendproof.core.stores.CommandKind;
import io.github.mprync.sendproof.core.stores.PreviewTransactionControlException;
import io.github.mprync.sendproof.core.stores.StoreClassifier;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import io.github.mprync.sendproof.core.stores.StoreRedaction;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import org.bson.BsonArray;
import org.bson.BsonBinary;
import org.bson.BsonDocument;
import org.bson.BsonInt32;
import org.bson.BsonString;
import org.bson.BsonValue;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The per-store engine shared by every MongoDB flavor (driver, reactive, Spring Data):
 *
 * <ul>
 *   <li><b>Topology:</b> {@code hello} decides the mode once. A replica set or mongos with logical sessions runs in
 *       {@code preview} mode; anything else in {@code guard} mode (spec/data-stores.md "Starting the transaction").</li>
 *   <li><b>Session:</b> each {@code preview}-mode Preview gets one client session with a snapshot/majority transaction.
 *       The handler's own {@code startTransaction} and {@code withTransaction} join it; its {@code commitTransaction}
 *       and {@code abortTransaction} never reach the server and fail the Preview with 500.</li>
 *   <li><b>Guard:</b> {@link #check} classifies a command before a guarded handle sends it.</li>
 *   <li><b>Monitoring (the tripwire):</b> every command the client sends is seen by {@link #listener()}. A write during
 *       a Preview without the Preview's {@code lsid} and {@code autocommit: false} fails the Preview with 500, a
 *       {@code commitTransaction} or {@code abortTransaction} that reached the server does too, a reply with code 263
 *       blocks it, and every other command becomes a {@code Db} log entry. Candidate document ids for change capture
 *       come from the same events.</li>
 *   <li><b>Finish:</b> after the handler, changes are read (inside the transaction for {@code after}, and at the
 *       transaction's own snapshot time for {@code before}), then the transaction is aborted and the session ended. A
 *       Preview that outlives the time limit is aborted and answers 500.</li>
 * </ul>
 */
final class MongoEngine {
    private static final Logger LOG = LoggerFactory.getLogger(MongoEngine.class);

    /** The reason a standalone server, or any reply the binding doesn't recognise, runs in {@code guard} mode. */
    static final String STANDALONE_REASON = "Preview unavailable: this MongoDB server doesn't support transactions";

    /**
     * The reason when the detection {@code hello} can't be sent or answered: whether the server supports transactions is
     * unknown, so the store runs in {@code guard} mode for now and asks again next time.
     */
    static final String UNREACHABLE_REASON = "Preview unavailable: couldn't reach MongoDB to check whether it supports "
            + "transactions, so this Preview runs in guard mode";

    /** The default Preview time limit: below the server's 60-second {@code transactionLifetimeLimitSeconds}. */
    static final long DEFAULT_TIMEOUT_MS = 50_000;

    /** Commands the monitoring specification marks security-sensitive: never logged. */
    private static final Set<String> SENSITIVE = Set.of("authenticate", "saslstart", "saslcontinue", "getnonce",
            "createuser", "updateuser", "copydbgetnonce", "copydbsaslstart", "copydb");

    /** Fields the driver adds to every command; they carry no meaning for the log and are dropped. */
    private static final Set<String> ENVELOPE = Set.of("lsid", "txnNumber", "autocommit", "startTransaction",
            "$clusterTime", "$db", "$readPreference", "readConcern", "writeConcern", "apiVersion", "apiStrict",
            "apiDeprecationErrors");

    /** Most candidate documents read back for change capture in one Preview. */
    private static final int CANDIDATE_LIMIT = 1000;

    /** Server error codes meaning the collection or snapshot didn't exist at the start time. */
    private static final Set<Integer> ABSENT_AT_START = Set.of(26 /* NamespaceNotFound */, 246 /* SnapshotUnavailable */);

    private static final ScheduledExecutorService TIMERS = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "sendproof-mongodb-preview-timeout");
        thread.setDaemon(true);
        return thread;
    });

    /** {@code NoSuchTransaction}: the server has no such transaction, so nothing holds its locks. */
    private static final int NO_SUCH_TRANSACTION = 251;

    /**
     * How long the engine keeps trying to end a Preview transaction whose abort the server never acknowledged, and the
     * backoff between tries. Well inside the server's 60-second transaction lifetime.
     */
    private static final long KILL_RETRY_LIMIT_MS = 10_000;
    private static final long KILL_FIRST_DELAY_MS = 100;
    private static final long KILL_MAX_DELAY_MS = 2_000;
    /** The most one {@code killSessions} try may take, server selection included. */
    private static final long KILL_TRY_TIMEOUT_MS = 2_000;

    /** Runs {@code killSessions} after a lost abort, so the Preview's reply never waits for the network. */
    private static final java.util.concurrent.ExecutorService KILLERS = Executors.newCachedThreadPool(task -> {
        Thread thread = new Thread(task, "sendproof-mongodb-kill-session");
        thread.setDaemon(true);
        return thread;
    });

    /** Set while the engine itself talks to the server, so monitoring ignores those commands. */
    static final ThreadLocal<Boolean> INTERNAL = new ThreadLocal<>();

    /** The mode a Preview runs in. */
    enum Mode { PREVIEW, GUARD }

    /** One document a Preview may have changed, and how. */
    private record Candidate(String namespace, String collection, BsonValue id, String via) {
    }

    /** A filter whose matches, before and inside the transaction, are change candidates. */
    private record Filter(String namespace, String collection, BsonDocument filter, String via) {
    }

    /** A command seen by monitoring, kept until its reply arrives. */
    private record Pending(RequestCapture capture, RequestCapture preview, String name, String namespace, String target,
                           String statement, long startedNanos, BsonDocument command) {
    }

    /** The driver transaction shared by all steps of a held Preview. */
    static final class Transaction {
        final Object session;
        final String lsid;
        final boolean held;
        volatile boolean sent;
        volatile boolean abortAcknowledged;
        volatile boolean finished;
        volatile MongoNamespace probe;
        volatile Throwable serverEnded;
        volatile Throwable unsafe;
        volatile PreviewState step;

        Transaction(Object session, String lsid, boolean held) {
            this.session = session;
            this.lsid = lsid;
            this.held = held;
        }
    }

    /** The state of one request enrolled in a transaction. */
    final class PreviewState {
        final Transaction transaction;
        final RequestCapture capture;
        final MongoHeldPreview.Turn held;
        final Object guarded;
        final Object driver;
        volatile boolean used;
        volatile boolean finished;
        final Map<String, Candidate> candidates = new LinkedHashMap<>();
        final List<Filter> filters = new ArrayList<>();
        /**
         * The transaction's snapshot time: the {@code operationTime} of the first reply to a command the Preview
         * session sent. {@code before} images are read at this time, so a concurrent commit by another request never
         * shows up as a Preview change.
         */
        volatile BsonValue startTime;
        volatile ScheduledFuture<?> timer;
        final SessionBinder binder;
        final PreviewSessions.Gate gate = new PreviewSessions.Gate();

        PreviewState(Transaction transaction, RequestCapture capture, SessionBinder binder, MongoHeldPreview.Turn held) {
            this.transaction = transaction;
            this.capture = capture;
            this.binder = binder;
            this.held = held;
            Object originator = ((com.mongodb.session.ClientSession) transaction.session).getOriginator();
            Object guardedOriginator = originator == null ? null : new GuardedMongo(MongoEngine.this).wrap(originator);
            this.guarded = PreviewSessions.create(backend, transaction.session, capture, gate, () -> guardedOriginator);
            this.driver = PreviewSessions.create(backend, transaction.session, capture, gate, null);
        }

        /** The driver session the handler sees: it joins the Preview transaction and refuses to end it. */
        Object guardedSession() {
            return guarded;
        }

        /** The session guarded handles pass to the driver: see {@link PreviewSessions}. */
        Object driverSession() {
            return driver;
        }

    }

    private final MongoBackend backend;
    private final Set<String> reads;
    private final long timeoutMs;
    /**
     * The mode each Preview began in. A Preview keeps the mode it began with even if detection later changes, so a
     * Preview that began without a session never has its writes treated as joining a transaction.
     */
    private final Map<RequestCapture, Mode> modes = Collections.synchronizedMap(new WeakHashMap<>());
    private final Map<RequestCapture, PreviewState> states = Collections.synchronizedMap(new WeakHashMap<>());
    private final Map<Integer, Pending> pending = new ConcurrentHashMap<>();
    /** Each Preview whose session is still open, by the hex of its {@code lsid}. */
    private final Map<String, Transaction> byLsid = new ConcurrentHashMap<>();
    /** The Preview of each {@code abortTransaction} sent and not yet answered, by request id. */
    private final Map<Integer, Transaction> aborts = new ConcurrentHashMap<>();
    private volatile DataStore.Description detected;
    private volatile Mode mode;
    private final String name;
    /** Proves the command listener is registered on this engine's own client: see {@link #detect}. */
    private final String probeToken = "sendproof-probe-" + java.util.UUID.randomUUID();
    private volatile boolean probeSeen;

    /** The reason Preview is unavailable when the engine's client doesn't report its commands to the listener. */
    static final String NO_TRIPWIRE_REASON = "Preview unavailable: the Sendproof command listener isn't registered on this MongoDB client";

    MongoEngine(MongoBackend backend, Set<String> reads, long timeoutMs, String name) {
        this.backend = backend;
        this.reads = reads;
        this.timeoutMs = timeoutMs;
        this.name = name;
    }

    MongoBackend backend() {
        return backend;
    }

    /** Runs engine-internal commands (topology, change capture, abort) without logging or tripping. */
    <T> T internal(Supplier<T> work) {
        Boolean previous = INTERNAL.get();
        INTERNAL.set(Boolean.TRUE);
        try {
            return work.get();
        } finally {
            if (previous == null) {
                INTERNAL.remove();
            } else {
                INTERNAL.set(previous);
            }
        }
    }

    /** Detects the topology once: {@code preview} on a replica set or mongos with logical sessions. */
    synchronized DataStore.Description detect() {
        if (detected != null) {
            return detected;
        }
        try {
            // The probe carries a token only this engine knows. The tripwire counts as installed only when the listener sees
            // that token on this client's own command, never because some other client's commands were seen.
            probeSeen = false;
            BsonDocument hello = internal(() -> backend.command("admin",
                    new BsonDocument("hello", new BsonInt32(1)).append("comment", new BsonString(probeToken)), null));
            if (!probeSeen) {
                mode = Mode.GUARD;
                detected = new DataStore.Description("mongodb", name, "guard", NO_TRIPWIRE_REASON);
                return detected;
            }
            boolean transactions = (hello.containsKey("setName") || (hello.containsKey("msg")
                    && "isdbgrid".equals(hello.getString("msg").getValue()))) && hello.containsKey("logicalSessionTimeoutMinutes")
                    && !hello.get("logicalSessionTimeoutMinutes").isNull();
            mode = transactions ? Mode.PREVIEW : Mode.GUARD;
            detected = transactions ? new DataStore.Description("mongodb", name, "preview", null)
                    : new DataStore.Description("mongodb", name, "guard", STANDALONE_REASON);
            return detected;
        } catch (RuntimeException failure) {
            // Guard mode for now, and ask again next time. A server that answered with an error is a reply this doesn't
            // recognise; one that couldn't be reached proves nothing about transactions, and says so.
            LOG.debug("MongoDB topology detection failed; Preview runs in guard mode for now.", failure);
            if (mode == null) {
                mode = Mode.GUARD;
            }
            return new DataStore.Description("mongodb", name, "guard",
                    failure instanceof com.mongodb.MongoServerException ? STANDALONE_REASON : UNREACHABLE_REASON);
        }
    }

    /** The current Preview's state, when the code runs in a {@code preview}-mode Preview that began. */
    PreviewState state() {
        RequestCapture capture = StoreGuard.currentPreview();
        return capture == null ? null : states.get(capture);
    }

    /**
     * Replaces a handler's Preview session among call arguments with its driver session, for a call made where no
     * Preview is current (another thread the handler handed its session to). The driver accepts only the driver's
     * session: see {@link PreviewSessions}.
     */
    Object[] driverSessions(Object[] args) {
        if (args == null) {
            return null;
        }
        Object[] result = args;
        for (int i = 0; i < args.length; i++) {
            if (args[i] != null && java.lang.reflect.Proxy.isProxyClass(args[i].getClass())) {
                synchronized (states) {
                    for (PreviewState state : states.values()) {
                        if (state.guarded == args[i]) {
                            result = result == args ? args.clone() : result;
                            result[i] = state.driver;
                        }
                    }
                }
            }
        }
        return result;
    }

    private Mode modeOf(RequestCapture capture) {
        Mode value = modes.get(capture);
        return value == null ? Mode.GUARD : value;
    }

    /**
     * Prepares a Preview: detects the mode and, in {@code preview} mode, starts the Preview's session and transaction.
     * The session handed to the handler joins the Preview transaction instead of ending it.
     */
    PreviewState begin(RequestCapture capture, SessionBinder binder) {
        PreviewState existing = states.get(capture);
        if (existing != null || modes.containsKey(capture)) {
            return existing;
        }
        Mode detectedMode = detect().mode().equals("preview") ? Mode.PREVIEW : Mode.GUARD;
        if (!capture.inPreviewScope()) {
            return null;
        }
        modes.put(capture, detectedMode);
        if (detectedMode != Mode.PREVIEW) {
            return null;
        }
        Transaction transaction = startTransaction(false);
        PreviewState state;
        try {
            state = enroll(transaction, capture, binder, null);
        } catch (RuntimeException failure) {
            end(transaction);
            throw failure;
        }
        // A handler still running at the limit loses its transaction: later commands fail, nothing commits, and the
        // Preview answers 500 when it ends.
        state.timer = TIMERS.schedule(() -> {
            capture.refuse(new PreviewTransactionControlException(
                    "The Preview ran longer than " + timeoutMs + " ms, so its MongoDB transaction was aborted."));
            endOrdinary(state);
        }, timeoutMs, TimeUnit.MILLISECONDS);
        return state;
    }

    private Transaction startTransaction(boolean held) {
        Object session = internal(backend::startTransaction);
        try {
            var transaction = new Transaction(session, backend.lsid(session), held);
            byLsid.put(transaction.lsid, transaction);
            return transaction;
        } catch (RuntimeException failure) {
            internal(() -> {
                backend.abort(session);
                backend.end(session);
                return null;
            });
            throw failure;
        }
    }

    MongoHeldPreview hold(SessionBinder binder) {
        DataStore.Description description = detect();
        if (UNREACHABLE_REASON.equals(description.reason())) {
            throw new IllegalStateException(description.reason());
        }
        return "preview".equals(description.mode()) ? new MongoHeldPreview(this, startTransaction(true), binder) : null;
    }

    PreviewState enroll(Transaction transaction, RequestCapture capture, SessionBinder binder, MongoHeldPreview.Turn held) {
        var state = new PreviewState(transaction, capture, binder, held);
        modes.put(capture, Mode.PREVIEW);
        states.put(capture, state);
        transaction.step = state;
        try {
            binder.bind(state.guardedSession());
            return state;
        } catch (RuntimeException failure) {
            seal(state);
            modes.put(capture, Mode.GUARD);
            states.remove(capture);
            transaction.step = null;
            throw failure;
        }
    }

    void seal(PreviewState state) {
        state.finished = true;
        state.gate.close();
    }

    void unbind(PreviewState state) {
        try {
            seal(state);
            state.binder.unbind();
        } finally {
            modes.put(state.capture, Mode.GUARD);
            states.remove(state.capture);
            state.transaction.step = null;
        }
    }

    /**
     * Classifies a command before it is sent and lets the guard refuse it. In {@code guard} mode every write blocks; in
     * {@code preview} mode only what MongoDB can't run inside a transaction does. A write on the admin, config or local
     * database runs outside the transaction, so it blocks too.
     */
    CommandKind check(Map<?, ?> command, String operation, String database) {
        RequestCapture capture = StoreGuard.currentPreview();
        var classified = StoreClassifier.mongo(command, reads);
        if (capture == null) {
            return classified.kind();
        }
        if (endsTransaction(operation.toLowerCase(Locale.ROOT))) {
            throw StoreGuard.refuseInPreview("Preview owns the MongoDB transaction, so the handler's " + operation
                    + " cannot run during Preview.");
        }
        if (modeOf(capture) == Mode.PREVIEW && !systemDatabase(database)) {
            PreviewState state = states.get(capture);
            if (state == null || state.finished) {
                throw StoreGuard.refuseInPreview("The Preview's MongoDB step has ended.");
            }
            if (classified.refusedInTransaction() != null) {
                StoreGuard.guard("mongodb", operation, CommandKind.WRITE,
                        StoreGuard.refusedReason(classified.refusedInTransaction()));
            }
            return classified.kind();
        }
        StoreGuard.guard("mongodb", operation, classified.kind(), null);
        return classified.kind();
    }

    /** Commands on these databases can't join a transaction. */
    static boolean systemDatabase(String database) {
        return "admin".equals(database) || "config".equals(database) || "local".equals(database);
    }

    private static boolean endsTransaction(String lower) {
        return lower.equals("committransaction") || lower.equals("aborttransaction");
    }

    // ---- Monitoring ----

    /**
     * A listener the store hands out before it has a client: a client's settings need it first. It forwards to the
     * engine once the store is attached; until then there is nothing to watch.
     */
    static final class Deferred {
        private volatile MongoEngine engine;

        void bind(MongoEngine bound) {
            this.engine = bound;
        }

        CommandListener listener() {
            return new CommandListener() {
                @Override
                public void commandStarted(CommandStartedEvent event) {
                    MongoEngine bound = engine;
                    if (bound != null) {
                        bound.started(event);
                    }
                }

                @Override
                public void commandSucceeded(CommandSucceededEvent event) {
                    MongoEngine bound = engine;
                    if (bound != null) {
                        bound.succeeded(event);
                    }
                }

                @Override
                public void commandFailed(CommandFailedEvent event) {
                    MongoEngine bound = engine;
                    if (bound != null) {
                        bound.failed(event);
                    }
                }
            };
        }
    }

    private static boolean internalEvent(com.mongodb.RequestContext context) {
        return INTERNAL.get() != null || (context instanceof CaptureRequestContext ours && ours.internal());
    }

    private static RequestCapture captureOf(com.mongodb.RequestContext context) {
        return context instanceof CaptureRequestContext ours && ours.capture() != null ? ours.capture()
                : CaptureContext.current();
    }

    private void started(CommandStartedEvent event) {
        try {
            if (event.getCommand().containsKey("comment") && event.getCommand().get("comment").isString()
                    && probeToken.equals(event.getCommand().getString("comment").getValue())) {
                probeSeen = true;
            }
            // Before the internal check: the engine sends the abort itself.
            String sessionId = byLsid.isEmpty() ? null : lsidOf(event.getCommand());
            Transaction own = sessionId == null ? null : byLsid.get(sessionId);
            if (own != null) {
                if (event.getCommandName().equals("abortTransaction")) {
                    aborts.put(event.getRequestId(), own);
                } else {
                    own.sent = true;
                    BsonValue target = event.getCommand().get(event.getCommandName());
                    if (own.held && own.probe == null && !systemDatabase(event.getDatabaseName())
                            && target instanceof BsonString collection) {
                        own.probe = new MongoNamespace(event.getDatabaseName(), collection.getValue());
                    }
                }
            }
            if (internalEvent(event.getRequestContext())) {
                return;
            }
            // The driver backs the event's document with a buffer it releases after this callback, and the document is
            // read again when the reply arrives: take a copy.
            BsonDocument command = event.getCommand().clone();
            String commandName = event.getCommandName();
            String lower = commandName.toLowerCase(Locale.ROOT);
            CommandKind kind = StoreClassifier.mongo(command, reads).kind();
            RequestCapture capture = captureOf(event.getRequestContext());
            RequestCapture preview = capture != null && capture.inPreviewScope() ? capture : null;
            if (own != null && own.held && (kind == CommandKind.WRITE || endsTransaction(lower))) {
                PreviewState step = own.step;
                if (endsTransaction(lower) || step == null || step.finished) {
                    own.unsafe = new PreviewTransactionControlException("A MongoDB " + commandName
                            + " reached the server outside the Preview's control.");
                } else if (preview == null && capture == null) {
                    preview = step.capture;
                }
            }
            if (preview != null && endsTransaction(lower)) {
                // Sent around the hook, for example through a raw client the guard never saw: it may have committed the
                // Preview transaction, so the Preview can never be confirmed.
                preview.refuse(new PreviewTransactionControlException("A MongoDB " + commandName
                        + " reached the server during a Preview; the Preview can't be confirmed."));
            } else if (preview != null && kind == CommandKind.WRITE) {
                watchWrite(preview, command, event.getDatabaseName(), lower, commandName);
            } else if (preview == null && kind == CommandKind.WRITE && capture == null
                    && !attributed(event.getRequestContext())) {
                unattributedWrite(command, event.getDatabaseName(), lower, commandName);
            }
            if (kind == CommandKind.SESSION || SENSITIVE.contains(lower)) {
                return;
            }
            String target = command.containsKey(commandName) && command.get(commandName).isString()
                    ? command.getString(commandName).getValue() : null;
            Map<String, Object> body = new LinkedHashMap<>();
            for (Map.Entry<String, BsonValue> entry : command.entrySet()) {
                if (!ENVELOPE.contains(entry.getKey())) {
                    body.put(entry.getKey(), entry.getValue());
                }
            }
            String statement = Json.MAPPER.writeValueAsString(StoreRedaction.sanitizeDocument(body));
            pending.put(event.getRequestId(), new Pending(capture, preview, commandName, event.getDatabaseName(), target,
                    statement, System.nanoTime(), command));
        } catch (Exception | LinkageError failure) {
            // Monitoring must never break a command.
            LOG.debug("Sendproof could not observe a MongoDB command.", failure);
        }
    }

    private static boolean attributed(com.mongodb.RequestContext context) {
        return context instanceof CaptureRequestContext ours ? ours.attributed() : CaptureContext.attributed();
    }

    /**
     * A write with no request behind it while Previews are open. If it carries an open Preview's own session it is that
     * Preview's write sent from another thread, and is watched as such. Otherwise nothing can say it isn't a Preview's
     * write that escaped, so every open Preview fails with 500. Background work declares itself detached to be exempt
     * ({@link CaptureContext#detached}).
     */
    private void unattributedWrite(BsonDocument command, String namespace, String lower, String original) {
        String lsid = lsidOf(command);
        java.util.List<Map.Entry<RequestCapture, PreviewState>> open;
        synchronized (states) {
            open = new ArrayList<>(states.entrySet());
        }
        for (Map.Entry<RequestCapture, PreviewState> entry : open) {
            if (entry.getValue().transaction.lsid.equals(lsid)) {
                watchWrite(entry.getKey(), command, namespace, lower, original);
                return;
            }
        }
        for (Map.Entry<RequestCapture, PreviewState> entry : open) {
            if (!entry.getValue().finished) {
                entry.getKey().refuse(new PreviewTransactionControlException("A MongoDB " + original
                        + " with no request attribution was sent while a Preview was open; it may have escaped the Preview, so the "
                        + "Preview can't be confirmed. Run background work inside CaptureContext.detached."));
            }
        }
    }

    /** A write seen during a Preview: collect change candidates, or trip if it escaped the session. */
    private void watchWrite(RequestCapture preview, BsonDocument command, String namespace, String name, String original) {
        PreviewState state = states.get(preview);
        String lsid = lsidOf(command);
        // Only a command inside the Preview transaction (its lsid and autocommit: false) rolls back.
        if (state == null || state.finished || !state.transaction.lsid.equals(lsid)
                || !(command.containsKey("autocommit") && command.get("autocommit").isBoolean()
                && !command.getBoolean("autocommit").getValue())) {
            // The hook couldn't stop it and nothing can undo it: never claim a rollback.
            preview.refuse(new PreviewTransactionControlException("A MongoDB " + original
                    + " escaped the Preview session; the Preview can't be confirmed."));
            return;
        }
        if (state.held != null) {
            state.held.observeWrite(preview, command, namespace, name);
            return;
        }
        state.used = true;
        String first = command.keySet().iterator().next();
        String collection = command.get(first).isString() ? command.getString(first).getValue() : "";
        synchronized (state) {
            if (name.equals("insert") && command.containsKey("documents") && command.get("documents").isArray()) {
                for (BsonValue document : command.getArray("documents")) {
                    if (document.isDocument()) {
                        candidate(state, new Candidate(namespace, collection, document.asDocument().get("_id"), null));
                    }
                }
            } else if (name.equals("update") && command.containsKey("updates") && command.get("updates").isArray()) {
                for (BsonValue value : command.getArray("updates")) {
                    BsonDocument update = value.asDocument();
                    String via = bool(update, "upsert") ? "upsert" : replaces(update.get("u")) ? "replace" : null;
                    state.filters.add(new Filter(namespace, collection, doc(update, "q"), via));
                }
            } else if (name.equals("delete") && command.containsKey("deletes") && command.get("deletes").isArray()) {
                for (BsonValue value : command.getArray("deletes")) {
                    state.filters.add(new Filter(namespace, collection, doc(value.asDocument(), "q"), null));
                }
            } else if (name.equals("findandmodify")) {
                String via = bool(command, "upsert") ? "upsert" : replaces(command.get("update")) ? "replace" : null;
                state.filters.add(new Filter(namespace, collection, doc(command, "query"), via));
            } else if (name.equals("bulkwrite") && command.containsKey("ops") && command.containsKey("nsInfo")) {
                // The client-level bulkWrite command: each op names its namespace by index.
                BsonArray infos = command.getArray("nsInfo");
                for (BsonValue value : command.getArray("ops")) {
                    BsonDocument op = value.asDocument();
                    BsonValue index = op.containsKey("insert") ? op.get("insert") : op.containsKey("update") ? op.get("update")
                            : op.get("delete");
                    String[] parts = new String[] {namespace, ""};
                    if (index != null && index.isNumber() && index.asNumber().intValue() < infos.size()) {
                        String ns = infos.get(index.asNumber().intValue()).asDocument().getString("ns").getValue();
                        int dot = ns.indexOf('.');
                        parts = dot < 0 ? new String[] {ns, ""} : new String[] {ns.substring(0, dot), ns.substring(dot + 1)};
                    }
                    if (op.containsKey("document")) {
                        candidate(state, new Candidate(parts[0], parts[1], op.getDocument("document").get("_id"), null));
                    } else {
                        state.filters.add(new Filter(parts[0], parts[1], doc(op, "filter"), bool(op, "upsert") ? "upsert" : null));
                    }
                }
            }
        }
    }

    private static BsonDocument doc(BsonDocument parent, String key) {
        return parent.containsKey(key) && parent.get(key).isDocument() ? parent.getDocument(key) : new BsonDocument();
    }

    private static boolean bool(BsonDocument parent, String key) {
        return parent.containsKey(key) && parent.get(key).isBoolean() && parent.getBoolean(key).getValue();
    }

    /** Whether an update document replaces the whole document rather than applying operators. */
    private static boolean replaces(BsonValue update) {
        if (update == null || !update.isDocument() || update.asDocument().isEmpty()) {
            return false;
        }
        return !update.asDocument().keySet().iterator().next().startsWith("$");
    }

    private static String lsidOf(BsonDocument command) {
        if (command.containsKey("lsid") && command.get("lsid").isDocument()) {
            BsonValue id = command.getDocument("lsid").get("id");
            if (id instanceof BsonBinary binary) {
                return SyncBackend.hex(binary);
            }
        }
        return null;
    }

    private void candidate(PreviewState state, Candidate candidate) {
        if (candidate.id() == null) {
            return;
        }
        String key = candidate.namespace() + "\u0000" + candidate.collection() + "\u0000" + BsonPlain.plain(candidate.id());
        Candidate known = state.candidates.get(key);
        if (known == null || (known.via() == null && candidate.via() != null)) {
            state.candidates.put(key, candidate);
        }
    }

    private void succeeded(CommandSucceededEvent event) {
        Transaction aborted = aborts.remove(event.getRequestId());
        if (aborted != null) {
            aborted.abortAcknowledged = true;
        }
        Pending taken = pending.remove(event.getRequestId());
        if (taken == null) {
            return;
        }
        try {
            BsonDocument reply = event.getResponse() == null ? new BsonDocument() : event.getResponse();
            PreviewState state = taken.preview() == null ? null : states.get(taken.preview());
            // The first reply in the transaction carries its snapshot time (the read timestamp).
            if (state != null && state.held == null && state.startTime == null && reply.containsKey("operationTime")
                    && state.transaction.lsid.equals(lsidOf(taken.command()))) {
                state.startTime = reply.get("operationTime");
            }
            if (state != null && state.held == null && taken.target() != null) {
                synchronized (state) {
                    // Upserted ids appear only in the reply.
                    if (reply.containsKey("upserted") && reply.get("upserted").isArray()) {
                        for (BsonValue upsert : reply.getArray("upserted")) {
                            candidate(state, new Candidate(taken.namespace(), taken.target(),
                                    upsert.asDocument().get("_id"), "upsert"));
                        }
                    }
                    if (taken.name().equalsIgnoreCase("findAndModify") && reply.containsKey("value") && reply.get("value").isDocument()
                            && reply.getDocument("value").containsKey("_id")) {
                        candidate(state, new Candidate(taken.namespace(), taken.target(),
                                reply.getDocument("value").get("_id"), null));
                    }
                    if (reply.containsKey("lastErrorObject") && reply.get("lastErrorObject").isDocument()
                            && reply.getDocument("lastErrorObject").containsKey("upserted")) {
                        candidate(state, new Candidate(taken.namespace(), taken.target(),
                                reply.getDocument("lastErrorObject").get("upserted"), "upsert"));
                    }
                }
            }
            Integer rows = null;
            if (reply.containsKey("cursor") && reply.get("cursor").isDocument()) {
                BsonDocument cursor = reply.getDocument("cursor");
                BsonValue batch = cursor.containsKey("firstBatch") ? cursor.get("firstBatch") : cursor.get("nextBatch");
                rows = batch != null && batch.isArray() ? batch.asArray().size() : 0;
            } else if (reply.containsKey("n") && reply.get("n").isNumber()) {
                rows = reply.get("n").asNumber().intValue();
            }
            log(taken, event.getElapsedTime(TimeUnit.NANOSECONDS), rows, null);
        } catch (RuntimeException failure) {
            LOG.debug("Sendproof could not record a MongoDB reply.", failure);
        }
    }

    private void failed(CommandFailedEvent event) {
        Transaction aborted = aborts.remove(event.getRequestId());
        // NoSuchTransaction: the server has no such transaction, so nothing holds its locks. A network error proves
        // nothing reached the server, and any other answer leaves the transaction in doubt.
        if (aborted != null && transactionEnded(event.getThrowable())) {
            aborted.abortAcknowledged = true;
        }
        Pending taken = pending.remove(event.getRequestId());
        if (taken == null) {
            return;
        }
        Throwable failure = event.getThrowable();
        String lsid = lsidOf(taken.command());
        Transaction transaction = lsid == null ? null : byLsid.get(lsid);
        if (transaction != null && transaction.held && transactionEnded(failure)) {
            transaction.serverEnded = failure;
        }
        String code = failure instanceof MongoCommandException command ? command.getErrorCodeName()
                : failure == null ? "Error" : failure.getClass().getSimpleName();
        // The server refused something a transaction can't do and applied nothing: a block, not a crash.
        if (taken.preview() != null && states.containsKey(taken.preview()) && failure instanceof MongoCommandException command
                && command.getErrorCode() == 263) {
            taken.preview().block(new BlockedWrite("mongodb", taken.name(), StoreGuard.refusedReason(taken.name())));
        }
        log(taken, event.getElapsedTime(TimeUnit.NANOSECONDS), null, code == null || code.isEmpty() ? "Error" : code);
    }

    static boolean transactionEnded(Throwable failure) {
        return failure instanceof MongoCommandException command && (command.getErrorCode() == NO_SUCH_TRANSACTION
                || "TransactionExceededLifetimeLimitSeconds".equals(command.getErrorCodeName()));
    }

    private void log(Pending taken, long elapsedNanos, Integer rows, String error) {
        if (taken.capture() == null) {
            return;
        }
        DbEntry entry = DbEntry.of("mongodb", taken.name()).withNamespace(taken.namespace()).withStatement(taken.statement())
                .withRows(rows).withError(error).withElapsed(elapsedNanos / 1_000_000.0);
        if (taken.target() != null) {
            entry = entry.withTarget(taken.target());
        }
        taken.capture().db(entry);
    }

    // ---- Finish ----

    /**
     * After the handler: captures document changes, then aborts the transaction and ends the session. A capture read
     * that fails for any reason but an already-aborted transaction rethrows after the abort, so the Preview answers 500,
     * as does an abort the server never acknowledged. Nothing the Preview wrote is ever committed: no
     * {@code commitTransaction} is ever sent for the Preview session.
     */
    void finish(RequestCapture capture) {
        PreviewState state = states.get(capture);
        if (state == null || state.finished) {
            return;
        }
        boolean ended = true;
        RuntimeException failure = null;
        try {
            if (state.used) {
                internal(() -> {
                    capture(capture, state);
                    return null;
                });
            }
        } catch (RuntimeException error) {
            // A failed command inside a transaction makes the server abort it: nothing to capture.
            if (!(error instanceof MongoCommandException command && "NoSuchTransaction".equals(command.getErrorCodeName()))) {
                failure = error;
            }
        } finally {
            ended = endOrdinary(state);
        }
        if (failure != null) {
            throw failure;
        }
        if (!ended) {
            // The server may still hold the transaction's locks; the session is killed in the background.
            throw new IllegalStateException(
                    "MongoDB didn't acknowledge the abort of the Preview transaction, so the rollback can't be confirmed.");
        }
    }

    /** Releases the Preview's session binding once the Preview is over. */
    void release(RequestCapture capture) {
        PreviewState state = states.get(capture);
        if (state != null) {
            endOrdinary(state);
            unbind(state);
        }
    }

    private boolean endOrdinary(PreviewState state) {
        seal(state);
        ScheduledFuture<?> timer = state.timer;
        if (timer != null) {
            timer.cancel(false);
        }
        return end(state.transaction);
    }

    /**
     * Aborts the Preview transaction and ends its session, once.
     *
     * <p>The driver ignores abort errors, as the transactions specification requires: an unacknowledged abort still
     * commits nothing, because no {@code commitTransaction} is ever sent for the Preview session. But the server then
     * keeps the transaction, and its locks, until its 60-second lifetime limit. So when a command was sent on the
     * session and the server didn't answer the abort, this returns {@code false} at once (the Preview answers 500) and
     * kills the session in the background.
     */
    boolean end(Transaction transaction) {
        synchronized (transaction) {
            if (transaction.finished) {
                return true;
            }
            transaction.finished = true;
        }
        boolean lost = internal(() -> {
            backend.abort(transaction.session);
            return transaction.sent && !transaction.abortAcknowledged && transaction.serverEnded == null;
        });
        if (!lost) {
            close(transaction);
            return true;
        }
        KILLERS.execute(() -> kill(transaction));
        return false;
    }

    /** Ends the session, after which the driver may hand its id to another operation. */
    private void close(Transaction transaction) {
        byLsid.remove(transaction.lsid, transaction);
        internal(() -> {
            backend.end(transaction.session);
            return null;
        });
    }

    /**
     * Ends the Preview transaction with {@code killSessions} after an abort the server never answered (the connection
     * dropped), retrying with backoff while the server can't be reached. A final failure is logged with the session id:
     * the server ends the transaction at its lifetime limit. The session stays open until then, so the driver can't hand
     * its id to another operation meanwhile.
     */
    private void kill(Transaction transaction) {
        String failure;
        try {
            var session = ((com.mongodb.session.ClientSession) transaction.session).getServerSession();
            // The id may still name a transaction on the server: never let the driver's pool reuse it.
            session.markDirty();
            failure = killSession(session.getIdentifier());
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            failure = "interrupted";
        } catch (RuntimeException refused) {
            failure = refused.getMessage();
        } finally {
            close(transaction);
        }
        if (failure != null) {
            LOG.warn("Couldn't end the transaction of MongoDB Preview session {} ({}); the server ends it, and releases its "
                    + "locks, at transactionLifetimeLimitSeconds.", transaction.lsid, failure);
        }
    }

    /**
     * Sends {@code killSessions} for one session id, retrying with backoff while the server can't be reached, for about
     * {@link #KILL_RETRY_LIMIT_MS} in all.
     *
     * @return {@code null} once the server ended the session, or why it couldn't be ended
     */
    String killSession(BsonDocument identifier) throws InterruptedException {
        var command = new BsonDocument("killSessions", new BsonArray(List.of(identifier)));
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(KILL_RETRY_LIMIT_MS);
        long delay = KILL_FIRST_DELAY_MS;
        while (true) {
            // Each try has its own short limit, so one that waits for a server never holds the window open.
            long timeout = Math.max(1, Math.min(KILL_TRY_TIMEOUT_MS,
                    TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())));
            try {
                internal(() -> backend.command("admin", command, timeout));
                return null;
            } catch (com.mongodb.MongoSocketException | com.mongodb.MongoTimeoutException unreachable) {
                // A network error or no server to select: try again shortly.
                long left = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
                if (left <= 0) {
                    return "MongoDB couldn't be reached for " + KILL_RETRY_LIMIT_MS / 1000 + " s";
                }
                Thread.sleep(Math.min(delay, left));
                delay = Math.min(delay * 2, KILL_MAX_DELAY_MS);
            } catch (RuntimeException refused) {
                return refused.getMessage();
            }
        }
    }

    /**
     * Finds documents as they were when the Preview transaction started: a snapshot read at its start time, outside the
     * transaction, by a raw {@code find} command. Without a start time (no reply carried one) it reads the
     * majority-committed view, which the spec allows: nothing the Preview wrote is committed, so the only difference is
     * a concurrent commit by another request.
     */
    private List<BsonDocument> atStart(PreviewState state, String namespace, String collection, BsonDocument filter,
                                       BsonDocument projection) {
        BsonDocument readConcern = state.startTime == null
                ? new BsonDocument("level", new BsonString("majority"))
                : new BsonDocument("level", new BsonString("snapshot")).append("atClusterTime", state.startTime);
        BsonDocument find = new BsonDocument("find", new BsonString(collection)).append("filter", filter);
        if (projection != null) {
            find.append("projection", projection);
        }
        find.append("batchSize", new BsonInt32(CANDIDATE_LIMIT)).append("limit", new BsonInt32(CANDIDATE_LIMIT))
                .append("singleBatch", org.bson.BsonBoolean.TRUE).append("readConcern", readConcern);
        try {
            BsonDocument reply = backend.command(namespace, find, null);
            var documents = new ArrayList<BsonDocument>();
            if (reply.containsKey("cursor") && reply.getDocument("cursor").containsKey("firstBatch")) {
                for (BsonValue value : reply.getDocument("cursor").getArray("firstBatch")) {
                    documents.add(value.asDocument());
                }
            }
            return documents;
        } catch (MongoCommandException error) {
            // The collection was created after the start time: nothing in it existed then.
            if (ABSENT_AT_START.contains(error.getErrorCode())) {
                return List.of();
            }
            throw error;
        }
    }

    /** Compares each candidate's start-time and in-transaction versions and records the differences. */
    private void capture(RequestCapture capture, PreviewState state) {
        List<Filter> filters;
        synchronized (state) {
            filters = List.copyOf(state.filters);
        }
        BsonDocument projection = new BsonDocument("_id", new BsonInt32(1));
        for (Filter filter : filters) {
            var documents = new ArrayList<>(backend.find(filter.namespace(), filter.collection(), filter.filter(),
                    projection, CANDIDATE_LIMIT, state.transaction.session));
            documents.addAll(atStart(state, filter.namespace(), filter.collection(), filter.filter(), projection));
            for (BsonDocument document : documents) {
                synchronized (state) {
                    candidate(state, new Candidate(filter.namespace(), filter.collection(), document.get("_id"), filter.via()));
                    if (state.candidates.size() >= CANDIDATE_LIMIT) {
                        break;
                    }
                }
            }
        }
        List<Candidate> candidates;
        synchronized (state) {
            candidates = List.copyOf(state.candidates.values());
        }
        int read = 0;
        for (Candidate candidate : candidates) {
            if (read++ >= CANDIDATE_LIMIT) {
                capture.truncateChanges();
                break;
            }
            BsonDocument byId = new BsonDocument("_id", candidate.id());
            List<BsonDocument> beforeDocuments = atStart(state, candidate.namespace(), candidate.collection(), byId, null);
            List<BsonDocument> afterDocuments = backend.find(candidate.namespace(), candidate.collection(), byId, null, 1,
                    state.transaction.session);
            JsonNode was = beforeDocuments.isEmpty() ? null : BsonPlain.plain(beforeDocuments.get(0));
            JsonNode now = afterDocuments.isEmpty() ? null : BsonPlain.plain(afterDocuments.get(0));
            if (java.util.Objects.equals(was, now)) {
                continue;
            }
            String operation = was == null ? "insert" : now == null ? "delete" : "update";
            capture.change(new PreviewChange(operation, candidate.collection(),
                    Map.of("_id", BsonPlain.plain(candidate.id())), was, now, "mongodb", candidate.namespace(),
                    candidate.via() != null && !operation.equals("delete") ? candidate.via() : null));
        }
    }
}
