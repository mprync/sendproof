package io.github.mprync.sendproof.jdbc;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.Statement;

/**
 * A view of the preview's one connection that application code can borrow like any pooled connection. It cannot end
 * the preview's transaction: {@code commit} does nothing, {@code close} returns nothing to a pool, and switching to
 * auto-commit is ignored. {@code unwrap} never exposes the driver's connection and {@code abort} is refused. The
 * preview's own session rolls back and releases the real connection.
 */
final class SharedConnection {
    private SharedConnection() {
    }

    static Connection of(Connection real, JdbcPreviewSession session) {
        InvocationHandler handler = (proxy, method, args) -> {
            switch (method.getName()) {
                case "close" -> {
                    return null;
                }
                case "commit", "setAutoCommit" -> {
                    session.requireStep();
                    return null;
                }
                case "getAutoCommit" -> {
                    return Boolean.FALSE;
                }
                case "isClosed" -> {
                    return session.isClosed();
                }
                case "unwrap" -> {
                    // The driver's own connection would let the caller commit around this view.
                    if (args[0] instanceof Class<?> type && type.isInstance(proxy)) {
                        return proxy;
                    }
                    throw session.refuse("Unwrapping the preview connection");
                }
                case "isWrapperFor" -> {
                    return args[0] instanceof Class<?> type && type.isInstance(proxy);
                }
                case "abort" -> throw session.refuse("Connection.abort()");
                case "setTransactionIsolation", "setCatalog", "setSchema", "setReadOnly", "setNetworkTimeout" -> {
                    if (session.held()) {
                        throw session.refuse("Changing Connection settings during a held Preview");
                    }
                }
                case "rollback" -> {
                    if (session.held() && (args == null || args.length == 0)) {
                        session.rollbackStep();
                        return null;
                    }
                    // A whole-transaction rollback reaches the real connection, where PreviewConnectionGuard records it
                    // and makes the backstop savepoint again.
                    session.checkSavepointCall("rollback", args);
                }
                case "setSavepoint", "releaseSavepoint" -> session.checkSavepointCall(method.getName(), args);
                default -> {
                    // Delegate everything else to the real connection.
                }
            }
            session.requireStep();
            Object result = invoke(real, method, args);
            return session.held() ? shield(result, method.getReturnType(), session, (Connection) proxy) : result;
        };
        return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class},
                handler);
    }

    /** JDBC child handles may otherwise return a native connection or unwrap around its transaction guard. */
    private static Object shield(Object result, Class<?> type, JdbcPreviewSession session, Connection connection) {
        if (result == null || !(Statement.class.isAssignableFrom(type) || type == ResultSet.class
                || type == DatabaseMetaData.class)) {
            return result;
        }
        return Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{type}, (proxy, method, args) -> {
            session.requireStep();
            return switch (method.getName()) {
                case "getConnection" -> connection;
                case "isWrapperFor" -> ((Class<?>) args[0]).isInstance(proxy);
                case "unwrap" -> {
                    if (((Class<?>) args[0]).isInstance(proxy)) {
                        yield proxy;
                    }
                    throw session.refuse("Unwrapping a JDBC handle in the held Preview");
                }
                default -> shield(invoke(result, method, args), method.getReturnType(), session, connection);
            };
        });
    }

    private static Object invoke(Object target, Method method, Object[] args) throws Throwable {
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException error) {
            throw error.getCause();
        }
    }
}
