package io.github.mprync.sendproof.jpa;

import io.github.mprync.sendproof.core.PreviewSavepoint;
import java.sql.SQLException;
import java.sql.Savepoint;
import java.util.Set;
import org.springframework.transaction.TransactionExecution;
import org.springframework.transaction.TransactionExecutionListener;

/**
 * Keeps a preview honest. While a preview's outer transaction is open on a thread, the guard:
 * <ul>
 *   <li>flushes the persistence context when a {@code @Transactional} method completes (see
 *       {@link PreviewFlushAdvisor}), so constraint violations surface where a real commit would raise them;</li>
 *   <li>refuses to start any other transaction ({@code REQUIRES_NEW}), whose commit would escape the rollback;</li>
 *   <li>backs {@link JpaConnectionGuard} and {@link SqlCaptureListener}, which refuse a handler's own
 *       {@code Connection.commit()}, {@code setAutoCommit(true)} and transaction-control or DDL statements.</li>
 * </ul>
 * It is registered once on the transaction manager and does nothing outside a preview.
 */
final class PreviewTransactionGuard implements TransactionExecutionListener {
    private static final ThreadLocal<Scope> CURRENT = new ThreadLocal<>();

    /** Raised when handler code would persist data outside the preview's rolled-back transaction. */
    static final class EnrollmentException extends IllegalStateException {
        private static final long serialVersionUID = 1L;

        EnrollmentException(String message) {
            super(message);
        }
    }

    /** One preview's state on one thread. */
    static final class Scope implements AutoCloseable {
        private final Runnable flush;
        private final Scope previous;
        private final Set<String> safeProcedures;
        private String system;
        private PreviewSavepoint savepoint;
        private boolean starting = true;
        private boolean finishing;
        private volatile boolean lost;
        private RuntimeException violation;

        private Scope(Runnable flush, Scope previous, String system, Set<String> safeProcedures) {
            this.flush = flush;
            this.previous = previous;
            this.system = system;
            this.safeProcedures = safeProcedures == null ? Set.of() : safeProcedures;
        }

        /** The SQL provider id the refusals follow, once known (from the provider or the Preview's connection). */
        String system() {
            return system;
        }

        void system(String resolved) {
            system = resolved;
        }

        /** Whether the database rolled the Preview transaction back on its own (see {@link #transactionLost()}). */
        boolean lost() {
            return lost;
        }

        /** Remembers the MySQL backstop savepoint made in the Preview transaction. */
        void savepoint(PreviewSavepoint made) {
            savepoint = made;
        }

        /** Marks the outer transaction as started; further new transactions are violations. */
        void started() {
            starting = false;
        }

        /**
         * Marks the end of the handler: the session itself is about to flush, roll back and reset the connection, so
         * connection-level refusals stop applying.
         */
        void finishing() {
            finishing = true;
        }

        /** Returns the first violation seen, or {@code null}. */
        RuntimeException violation() {
            return violation;
        }

        void flush() {
            flush.run();
        }

        @Override
        public void close() {
            if (previous == null) {
                CURRENT.remove();
            } else {
                CURRENT.set(previous);
            }
        }
    }

    /** Begins guarding the current thread; call {@link Scope#started()} once the outer transaction exists. */
    static Scope enter(Runnable flush) {
        return enter(flush, null, Set.of());
    }

    /**
     * Begins guarding the current thread with the database's refusals.
     *
     * @param system         the SQL provider id, or {@code null} to read it from each statement's connection
     * @param safeProcedures procedures the host declared never commit, normalised by {@code TransactionControl}
     */
    static Scope enter(Runnable flush, String system, Set<String> safeProcedures) {
        Scope scope = new Scope(flush, CURRENT.get(), system, safeProcedures);
        CURRENT.set(scope);
        return scope;
    }

    /** The guarding preview's SQL provider id, or {@code null} when it is unknown or no preview guards this thread. */
    static String system() {
        Scope scope = CURRENT.get();
        return scope == null ? null : scope.system;
    }

    /**
     * Records that the database rolled the Preview transaction back on its own (a deadlock, a lock wait timeout, or a SQL
     * Server error under {@code XACT_ABORT ON}): every later statement in the Preview is refused, its final flush is
     * skipped, and the Preview fails. The handler still gets the database's original error.
     */
    static void transactionLost() {
        Scope scope = CURRENT.get();
        if (scope == null || scope.lost || !isHandling()) {
            return;
        }
        scope.lost = true;
        violation(new EnrollmentException("The database rolled the Sendproof preview's transaction back after a deadlock, "
                + "lock wait timeout or aborting error, so the operation can't be confirmed."));
    }

    /** Whether the guarding preview's transaction was rolled back by the database (see {@link #transactionLost()}). */
    static boolean isLost() {
        Scope scope = CURRENT.get();
        return scope != null && scope.lost;
    }

    /** The guarding preview's declared safe procedures. */
    static Set<String> safeProcedures() {
        Scope scope = CURRENT.get();
        return scope == null ? Set.of() : scope.safeProcedures;
    }

    /**
     * Records that the handler rolled the whole transaction back. Nothing escapes a rollback, but it erases the MySQL
     * backstop savepoint, so it is made again; failing that, the Preview can't be confirmed.
     */
    static void handlerRolledBack() {
        Scope scope = CURRENT.get();
        if (scope == null || scope.savepoint == null || !isHandling()) {
            return;
        }
        try {
            scope.savepoint.reopen();
        } catch (SQLException failure) {
            violation(new EnrollmentException("The Preview's MySQL savepoint couldn't be restored after the handler's "
                    + "rollback, so the operation can't be confirmed."));
        }
    }

    /**
     * Refuses a JDBC savepoint call naming the backstop savepoint ({@code setSavepoint(name)},
     * {@code releaseSavepoint(sp)}, {@code rollback(sp)}), which the driver sends past the SQL capture.
     */
    static RuntimeException refuseSavepointCall(String method, Object[] args) {
        Scope scope = CURRENT.get();
        if (scope == null || scope.savepoint == null || args == null || args.length != 1) {
            return null;
        }
        String name = null;
        if (args[0] instanceof String text) {
            name = text;
        } else if (args[0] instanceof Savepoint point) {
            try {
                name = point.getSavepointName();
            } catch (SQLException | RuntimeException unnamed) {
                return null;
            }
        }
        return name != null && name.replace("`", "").equalsIgnoreCase(PreviewSavepoint.NAME)
                ? refuseWhileHandling("Connection." + method + "() of the Preview's savepoint") : null;
    }

    /** Flushes the preview in progress on this thread, if any. Called when a transactional method completes. */
    static void flushIfActive() {
        Scope scope = CURRENT.get();
        if (scope != null && !scope.starting) {
            scope.flush();
        }
    }

    /** Records a violation against the preview guarding this thread, if any, and returns it for throwing. */
    static RuntimeException violation(RuntimeException violation) {
        Scope scope = CURRENT.get();
        if (scope != null && scope.violation == null) {
            scope.violation = violation;
        }
        return violation;
    }

    /** Returns whether a preview is guarding this thread. */
    static boolean isActive() {
        return CURRENT.get() != null;
    }

    /** Returns whether the handler of a preview is running on this thread (after begin, before the rollback). */
    static boolean isHandling() {
        Scope scope = CURRENT.get();
        return scope != null && !scope.starting && !scope.finishing;
    }

    /**
     * Records and returns a violation for an action that would end the preview's transaction, when the handler of a
     * preview is running on this thread; otherwise returns {@code null}.
     */
    static RuntimeException refuseWhileHandling(String action) {
        if (!isHandling()) {
            return null;
        }
        return violation(new EnrollmentException(action + " ran during a Sendproof preview and would have ended the "
                + "rolled-back transaction. The operation is not previewable."));
    }

    @Override
    public void beforeBegin(TransactionExecution transaction) {
        Scope scope = CURRENT.get();
        if (scope != null && !scope.starting) {
            scope.violation = new EnrollmentException("A new transaction ("
                    + transaction.getTransactionName() + ") was started during a Sendproof preview. "
                    + "Its commit would escape the rollback, so the operation is not previewable.");
            throw scope.violation;
        }
    }
}
