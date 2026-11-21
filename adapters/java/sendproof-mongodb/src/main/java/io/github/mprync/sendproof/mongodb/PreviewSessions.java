package io.github.mprync.sendproof.mongodb;

import io.github.mprync.sendproof.core.RequestCapture;
import io.github.mprync.sendproof.core.stores.PreviewTransactionControlException;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.function.Supplier;

/**
 * The sessions that stand for the Preview's real driver session. There are two, sharing one {@link Gate}:
 *
 * <ul>
 *   <li>the <b>handler's session</b>, the only one handler code can reach ({@code startSession}, Spring Data's bound
 *       session). Its {@code getOriginator()} answers the <em>guarded</em> client, never the raw one. The driver accepts
 *       a session only from the client it came from, so passing the handler's session to any raw client fails in the
 *       driver before anything is sent: a {@code commitTransaction} of the Preview transaction through another client
 *       is never sent;</li>
 *   <li>the <b>driver's session</b>, which guarded handles substitute for the handler's session on every call they
 *       make. Its {@code getOriginator()} answers the real client, as the driver requires. Handler code never sees
 *       it.</li>
 * </ul>
 *
 * <p>Both carry the Preview's {@code lsid}, so every command joins the Preview transaction, and neither can end it:
 *
 * <ul>
 *   <li>{@code startTransaction} does nothing, because the transaction is already open;</li>
 *   <li>{@code withTransaction} runs its body in the Preview transaction;</li>
 *   <li>{@code commitTransaction} and {@code abortTransaction} never reach the server: they record a fault, which fails
 *       the Preview with 500 even if the handler catches the error, and refuse;</li>
 *   <li>{@code close} does nothing: the Preview ends its session after the handler.</li>
 *   <li>once the Preview has ended (after the handler, or at the time limit, possibly while the handler still runs) every
 *       call is refused: an aborted session that is still open would otherwise run a command outside the transaction,
 *       and that command would commit.</li>
 * </ul>
 */
final class PreviewSessions {
    private PreviewSessions() {
    }

    /**
     * Closes the handler's session for good before the engine aborts the real one. Each call through the handler's
     * session holds the read lock while it reaches the real session; {@link #close} takes the write lock, so it waits for
     * calls already in flight (a driver that saw the transaction active sends its command inside it, where the abort
     * discards it) and every later call is refused. No lock is held while the engine talks to the server.
     */
    static final class Gate {
        private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();
        private boolean closed;

        void close() {
            lock.writeLock().lock();
            try {
                closed = true;
            } finally {
                lock.writeLock().unlock();
            }
        }
    }

    private static final StackWalker WALKER = StackWalker.getInstance();

    /**
     * Whether the code asking is the MongoDB driver itself, past the proxy and reflection frames.
     *
     * <p>The driver offers no other signal: the reactive driver's {@code ClientSessionHelper} asks for the originator
     * before anything driver-only reaches the session, so the caller's package is the only way to tell the driver's
     * own "session from the same client" check from handler code. {@code DriverOriginatorCheckTest} pins that driver
     * behaviour (sync and reactive), so a driver upgrade that changes it fails loudly.
     */
    static boolean calledByDriver() {
        return calledByDriver(PreviewSessions.class);
    }

    /**
     * {@link #calledByDriver()} for a session proxy whose invocation handler lives in {@code handlerClass}; its frames
     * (and its nested classes') are skipped like the proxy's own.
     */
    static boolean calledByDriver(Class<?> handlerClass) {
        return WALKER.walk(frames -> frames.map(StackWalker.StackFrame::getClassName)
                .filter(name -> !name.startsWith(PreviewSessions.class.getName())
                        && !name.startsWith(handlerClass.getName()) && !name.startsWith("jdk.proxy")
                        && !name.startsWith("com.sun.proxy") && !name.startsWith("java.lang.reflect")
                        && !name.startsWith("jdk.internal.reflect"))
                .findFirst().map(name -> name.startsWith("com.mongodb.")).orElse(false));
    }

    /**
     * Wraps the real session. The result implements the backend's {@code ClientSession} interface.
     *
     * @param originator {@code null} for the driver's session, whose originator is the real client; for the handler's
     *                   session, supplies the guarded client its {@code getOriginator()} answers
     */
    static Object create(MongoBackend backend, Object real, RequestCapture capture, Gate gate, Supplier<Object> originator) {
        InvocationHandler handler = (proxy, method, args) -> handle(backend, real, capture, gate, originator, proxy, method, args);
        return Proxy.newProxyInstance(PreviewSessions.class.getClassLoader(), new Class<?>[] {backend.sessionType()}, handler);
    }

    private static Object handle(MongoBackend backend, Object real, RequestCapture capture, Gate gate,
                                 Supplier<Object> originator, Object proxy, Method method, Object[] args) throws Throwable {
        String name = method.getName();
        if (method.getDeclaringClass() == Object.class) {
            return switch (name) {
                case "equals" -> proxy == args[0];
                case "hashCode" -> System.identityHashCode(proxy);
                default -> "Sendproof Preview session " + real;
            };
        }
        if (originator != null && name.equals("getOriginator") && (args == null || args.length == 0)) {
            if (calledByDriver()) {
                // A client Sendproof doesn't guard is about to send a command with the Preview's session, such as a
                // commitTransaction. Its own originator check would refuse it anyway; record the escape so the Preview
                // fails with 500 even if the handler swallows the error, and refuse before the driver goes further.
                var escape = new PreviewTransactionControlException("The Preview's MongoDB session was passed to a client "
                        + "Sendproof doesn't guard; nothing was sent, and the Preview can't be confirmed.");
                capture.refuse(escape);
                throw escape;
            }
            // Handler code never gets a route to the raw client from its session.
            return originator.get();
        }
        switch (name) {
            case "startTransaction", "close":
                // The Preview owns the transaction and the session.
                return null;
            case "withTransaction":
                // The body runs in the Preview transaction; its result (or Publisher) is returned unchanged.
                Method execute = args[0].getClass().getMethod("execute");
                execute.setAccessible(true);
                try {
                    return execute.invoke(args[0]);
                } catch (InvocationTargetException failure) {
                    throw failure.getCause();
                }
            case "commitTransaction", "abortTransaction":
                var refusal = new PreviewTransactionControlException("Preview owns the MongoDB transaction, so the handler's "
                        + name + " cannot run during Preview.");
                capture.refuse(refusal);
                if (backend.reactive() && !method.getReturnType().equals(void.class)) {
                    return backend.failed(refusal);
                }
                throw refusal;
            default:
                gate.lock.readLock().lock();
                try {
                    if (gate.closed) {
                        var ended = new PreviewTransactionControlException("The Preview's MongoDB transaction has ended, so its "
                                + "session can't carry another command.");
                        capture.refuse(ended);
                        throw ended;
                    }
                    return method.invoke(real, args);
                } catch (InvocationTargetException failure) {
                    throw failure.getCause();
                } finally {
                    gate.lock.readLock().unlock();
                }
        }
    }
}
