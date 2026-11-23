package io.github.mprync.sendproof.jpa;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ParameterMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Savepoint;
import java.sql.Statement;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Gives Spring a per-step connection handle while keeping physical transaction ownership in the held Preview. */
final class PinnedConnection implements AutoCloseable {
    private static final ThreadLocal<PinnedConnection> CURRENT = new ThreadLocal<>();
    private static final Set<String> CONNECTION_CHANGES = Set.of("abort", "setCatalog", "setSchema", "setReadOnly",
            "setTransactionIsolation", "setHoldability", "setNetworkTimeout", "setTypeMap", "beginRequest",
            "endRequest", "setShardingKey", "setShardingKeyIfValid");

    private final CaptureDataSource dataSource;
    private final Connection physical;
    private final Set<Savepoint> savepoints = Collections.newSetFromMap(new IdentityHashMap<>());
    private Connection handle;
    private boolean cleaningUp;

    PinnedConnection(CaptureDataSource dataSource, Connection physical) {
        if (current() != null) {
            throw new IllegalStateException("A held Preview step is already enrolled on this thread.");
        }
        this.dataSource = dataSource;
        this.physical = physical;
        CURRENT.set(this);
    }

    static PinnedConnection current() {
        return CURRENT.get();
    }

    Connection borrow(CaptureDataSource source) throws SQLException {
        if (source != dataSource || handle != null) {
            throw refuse("An additional JDBC connection was requested");
        }
        handle = protect(Connection.class, dataSource.capturePinned(physical), null);
        return handle;
    }

    void verifyEnlisted() {
        if (!TransactionSynchronizationManager.hasResource(dataSource)) {
            throw refuse("Spring did not bind a JDBC connection");
        }
        Connection enrolled = DataSourceUtils.getConnection(dataSource);
        try {
            if (enrolled != handle) {
                throw refuse("Spring did not use the pinned JDBC connection");
            }
        } finally {
            DataSourceUtils.releaseConnection(enrolled, dataSource);
        }
    }

    void cleaningUp() {
        cleaningUp = true;
    }

    RuntimeException refuse(String action) {
        return PreviewTransactionGuard.violation(new PreviewTransactionGuard.EnrollmentException(
                action + " during a held Sendproof Preview."));
    }

    /**
     * Keep the captured handle behind JDBC interfaces, including handles returned by metadata and statements.
     * Native handles would let application code bypass both the transaction and SQL guards.
     */
    private <T> T protect(Class<T> type, T target, Statement statement) {
        return proxy(type, (proxy, method, args) -> {
            String name = method.getName();
            if (method.getDeclaringClass() == Object.class) {
                return switch (name) {
                    case "equals" -> proxy == args[0];
                    case "hashCode" -> System.identityHashCode(proxy);
                    default -> "Sendproof Preview " + type.getSimpleName();
                };
            }
            if (current() != this) {
                return switch (name) {
                    case "close" -> null;
                    case "isClosed" -> true;
                    default -> throw new SQLException("The held Preview's JDBC handle is outside its step.");
                };
            }
            if (name.equals("unwrap") || name.equals("isWrapperFor")) {
                Class<?> requested = (Class<?>) args[0];
                if (name.equals("isWrapperFor")) {
                    return requested.isInstance(proxy);
                }
                if (requested.isInstance(proxy)) {
                    return proxy;
                }
                throw new SQLException("The held Preview's JDBC handle cannot be unwrapped.");
            }
            if (name.equals("getConnection") && method.getReturnType() == Connection.class) {
                return handle;
            }
            if (type == Connection.class) {
                if (name.equals("close")) {
                    return null;
                }
                if (CONNECTION_CHANGES.contains(name)) {
                    throw refuse("Connection." + name + "() was requested");
                }
                if (name.equals("rollback") && method.getParameterCount() == 0 && cleaningUp) {
                    return null;
                }
                if (name.equals("commit") || name.equals("rollback") && method.getParameterCount() == 0
                        || name.equals("setAutoCommit") && Boolean.TRUE.equals(args[0])) {
                    throw refuse("Connection." + name + "() would end the held transaction");
                }
                if (method.getParameterCount() == 1 && (name.equals("rollback") || name.equals("releaseSavepoint"))
                        && !savepoints.contains(args[0])) {
                    throw refuse("Connection." + name + "() used a savepoint outside its held Preview step");
                }
            }
            if (type == ResultSet.class && name.equals("getStatement")) {
                return statement;
            }
            Object result = invoke(target, method, args);
            if (result instanceof Savepoint made) {
                savepoints.add(made);
            } else if (name.equals("releaseSavepoint")) {
                savepoints.remove(args[0]);
            }
            // A driver may implement metadata and a statement or result set on the same object.
            if (method.getReturnType() == ResultSetMetaData.class && result instanceof ResultSetMetaData metadata) {
                return protect(ResultSetMetaData.class, metadata, null);
            }
            if (method.getReturnType() == ParameterMetaData.class && result instanceof ParameterMetaData metadata) {
                return protect(ParameterMetaData.class, metadata, null);
            }
            if (result instanceof CallableStatement callable) {
                return protect(CallableStatement.class, callable, null);
            }
            if (result instanceof PreparedStatement prepared) {
                return protect(PreparedStatement.class, prepared, null);
            }
            if (result instanceof Statement returned) {
                return protect(Statement.class, returned, null);
            }
            if (result instanceof ResultSet rows) {
                return protect(ResultSet.class, rows, proxy instanceof Statement parent ? parent : null);
            }
            if (result instanceof DatabaseMetaData metadata) {
                return protect(DatabaseMetaData.class, metadata, null);
            }
            return result;
        });
    }

    private static Object invoke(Object target, Method method, Object[] args) throws Throwable {
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException failure) {
            throw failure.getCause();
        }
    }

    private static <T> T proxy(Class<T> type, java.lang.reflect.InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(PinnedConnection.class.getClassLoader(), new Class<?>[] {type}, handler));
    }

    @Override
    public void close() {
        CURRENT.remove();
    }
}
