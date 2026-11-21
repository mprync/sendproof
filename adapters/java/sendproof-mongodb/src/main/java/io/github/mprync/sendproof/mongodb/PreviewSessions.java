package io.github.mprync.sendproof.mongodb;

import io.github.mprync.sendproof.core.RequestCapture;
import io.github.mprync.sendproof.core.stores.PreviewTransactionControlException;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

/**
 * The driver session a handler sees during a Preview. It is the Preview's own session, so every command it carries
 * joins the Preview transaction, but it cannot end it:
 *
 * <ul>
 *   <li>{@code startTransaction} does nothing, because the transaction is already open;</li>
 *   <li>{@code withTransaction} runs its body in the Preview transaction;</li>
 *   <li>{@code commitTransaction} and {@code abortTransaction} never reach the server: they record a fault, which fails
 *       the Preview with 500 even if the handler catches the error, and refuse;</li>
 *   <li>{@code close} does nothing: the Preview ends its session after the handler.</li>
 * </ul>
 */
final class PreviewSessions {
    private PreviewSessions() {
    }

    /** Wraps the real session. The result implements the backend's {@code ClientSession} interface. */
    static Object create(MongoBackend backend, Object real, RequestCapture capture) {
        InvocationHandler handler = (proxy, method, args) -> handle(backend, real, capture, proxy, method, args);
        return Proxy.newProxyInstance(PreviewSessions.class.getClassLoader(), new Class<?>[] {backend.sessionType()}, handler);
    }

    private static Object handle(MongoBackend backend, Object real, RequestCapture capture, Object proxy, Method method,
                                 Object[] args) throws Throwable {
        String name = method.getName();
        if (method.getDeclaringClass() == Object.class) {
            return switch (name) {
                case "equals" -> proxy == args[0];
                case "hashCode" -> System.identityHashCode(proxy);
                default -> "Sendproof Preview session " + real;
            };
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
                try {
                    return method.invoke(real, args);
                } catch (InvocationTargetException failure) {
                    throw failure.getCause();
                }
        }
    }
}
