package dev.testbench.jpa;

import org.springframework.transaction.TransactionExecution;
import org.springframework.transaction.TransactionExecutionListener;

/**
 * Keeps a preview honest. While a preview's outer transaction is open on a thread, the guard:
 * <ul>
 *   <li>flushes the persistence context when a {@code @Transactional} method completes (see
 *       {@link PreviewFlushAdvisor}), so constraint violations surface where a real commit would raise them;</li>
 *   <li>refuses to start any other transaction ({@code REQUIRES_NEW}), whose commit would escape the rollback.</li>
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
        private boolean starting = true;
        private RuntimeException violation;

        private Scope(Runnable flush, Scope previous) {
            this.flush = flush;
            this.previous = previous;
        }

        /** Marks the outer transaction as started; further new transactions are violations. */
        void started() {
            starting = false;
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
        Scope scope = new Scope(flush, CURRENT.get());
        CURRENT.set(scope);
        return scope;
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

    @Override
    public void beforeBegin(TransactionExecution transaction) {
        Scope scope = CURRENT.get();
        if (scope != null && !scope.starting) {
            scope.violation = new EnrollmentException("A new transaction ("
                    + transaction.getTransactionName() + ") was started during a Test Bench preview. "
                    + "Its commit would escape the rollback, so the operation is not previewable.");
            throw scope.violation;
        }
    }
}
