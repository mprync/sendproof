package dev.testbench.jdbc;

/**
 * The JDBC state of one request: the enrolled preview connection (when previewing) and the changes captured so far.
 *
 * <p>It is carried in a {@link ThreadLocal}. Coroutine-based frameworks must propagate it across thread hops, for
 * example with {@code JdbcScope.holder().asContextElement(scope)} in Kotlin, around the code that handles the request.
 */
public final class JdbcScope {
    private static final ThreadLocal<JdbcScope> CURRENT = new ThreadLocal<>();

    private final ChangeLog changes = new ChangeLog();
    private volatile JdbcPreviewSession session;

    /** Creates an empty scope. Make it current with {@link #enter()} or {@link #holder()}. */
    public JdbcScope() {
    }

    /** Returns the scope for this thread, or {@code null}. */
    public static JdbcScope current() {
        return CURRENT.get();
    }

    /** Returns the thread-local for coroutine integrations. Prefer {@link #enter()}. */
    public static ThreadLocal<JdbcScope> holder() {
        return CURRENT;
    }

    /** Makes this scope current on this thread until the returned handle is closed. */
    public Handle enter() {
        JdbcScope previous = CURRENT.get();
        CURRENT.set(this);
        return () -> {
            if (previous == null) {
                CURRENT.remove();
            } else {
                CURRENT.set(previous);
            }
        };
    }

    ChangeLog changes() {
        return changes;
    }

    JdbcPreviewSession session() {
        return session;
    }

    void session(JdbcPreviewSession session) {
        this.session = session;
    }

    /** A restorable binding of the current scope. */
    @FunctionalInterface
    public interface Handle extends AutoCloseable {
        /** Restores the previous scope. */
        @Override
        void close();
    }
}
