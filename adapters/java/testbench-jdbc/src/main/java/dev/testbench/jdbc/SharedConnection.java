package dev.testbench.jdbc;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;

/**
 * A view of the preview's one connection that application code can borrow like any pooled connection. It cannot end
 * the preview's transaction: {@code commit} does nothing, {@code close} returns nothing to a pool, and switching to
 * auto-commit is ignored. The preview's own session rolls back and releases the real connection.
 */
final class SharedConnection {
    private SharedConnection() {
    }

    static Connection of(Connection real, JdbcPreviewSession session) {
        InvocationHandler handler = (proxy, method, args) -> {
            switch (method.getName()) {
                case "close", "commit" -> {
                    return null;
                }
                case "setAutoCommit" -> {
                    return null;
                }
                case "getAutoCommit" -> {
                    return Boolean.FALSE;
                }
                case "isClosed" -> {
                    return session.isClosed();
                }
                case "rollback" -> {
                    if (args == null || args.length == 0) {
                        session.rolledBackEarly();
                    }
                }
                default -> {
                    // Delegate everything else to the real connection.
                }
            }
            try {
                return method.invoke(real, args);
            } catch (InvocationTargetException error) {
                throw error.getCause();
            }
        };
        return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class},
                handler);
    }
}
