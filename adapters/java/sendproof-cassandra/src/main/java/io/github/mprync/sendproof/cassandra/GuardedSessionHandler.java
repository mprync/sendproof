package io.github.mprync.sendproof.cassandra;

import com.datastax.oss.driver.api.core.CqlIdentifier;
import com.datastax.oss.driver.api.core.CqlSession;
import com.datastax.oss.driver.api.core.cql.AsyncResultSet;
import com.datastax.oss.driver.api.core.cql.BatchStatement;
import com.datastax.oss.driver.api.core.cql.BoundStatement;
import com.datastax.oss.driver.api.core.cql.PrepareRequest;
import com.datastax.oss.driver.api.core.cql.ResultSet;
import com.datastax.oss.driver.api.core.cql.SimpleStatement;
import io.github.mprync.sendproof.core.stores.CommandKind;
import io.github.mprync.sendproof.core.stores.GuardOnlyStore.Observation;
import io.github.mprync.sendproof.core.stores.Partiql;
import io.github.mprync.sendproof.core.stores.StoreClassifier;
import io.github.mprync.sendproof.core.stores.StoreClassifier.Classified;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.Set;
import java.util.StringJoiner;
import java.util.concurrent.CompletionStage;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The proxy behind {@link CassandraStore#session}. It lets the driver's session-level calls through and checks every
 * other call, so a method this version of the driver adds is guarded too: the first argument is classified, and anything
 * the guard can't read is a write.
 *
 * <p>The checks run on the calling thread, before the call reaches the real session. The convenience methods of
 * {@code CqlSession} ({@code execute(String)}, {@code executeAsync(Statement)}, {@code executeReactive}) are interface
 * methods the proxy sees first, so the real session's own internal calls are never double-counted.
 */
final class GuardedSessionHandler implements InvocationHandler {
    /** Calls that carry no statement: the session's metadata, schema and lifecycle. */
    private static final Set<String> SESSION_CALLS = Set.of("getName", "getMetadata", "isSchemaMetadataEnabled",
            "setSchemaMetadataEnabled", "refreshSchemaAsync", "refreshSchema", "checkSchemaAgreementAsync",
            "checkSchemaAgreement", "getContext", "getKeyspace", "getMetrics", "closeFuture", "closeAsync",
            "forceCloseAsync", "close", "isClosed", "onClose", "whenClosed");
    /** {@code PREPARE} only parses a statement. */
    private static final Set<String> PREPARE_CALLS = Set.of("prepare", "prepareAsync");
    private static final Pattern TABLE = Pattern.compile(
            "\\b(?:FROM|INTO|UPDATE|TRUNCATE(?:\\s+TABLE)?|TABLE)\\s+(\"[^\"]+\"|\\w+)(?:\\.(\"[^\"]+\"|\\w+))?",
            Pattern.CASE_INSENSITIVE);

    private final CassandraStore store;
    private final CqlSession session;

    GuardedSessionHandler(CassandraStore store, CqlSession session) {
        this.store = store;
        this.session = session;
    }

    /** A statement the guard has read: what it is, and the pieces of its {@code Db} entry. */
    private record Described(Classified classified, String target, String namespace, String statement) {
    }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        String name = method.getName();
        if (method.getDeclaringClass() == Object.class) {
            return switch (name) {
                case "equals" -> proxy == args[0];
                case "hashCode" -> System.identityHashCode(proxy);
                default -> "Sendproof-guarded " + session;
            };
        }
        if (method.getDeclaringClass() == CassandraStore.GuardedSession.class) {
            return store;
        }
        if (SESSION_CALLS.contains(name) || PREPARE_CALLS.contains(name)
                || (args != null && args.length > 0 && args[0] instanceof PrepareRequest)) {
            return forward(method, args);
        }
        Described described = describe(name, args == null || args.length == 0 ? null : args[0]);
        Observation call = store.start(described.classified(), described.target(), described.namespace(), described.statement());
        Object result;
        try {
            result = forward(method, args);
        } catch (Throwable failure) {
            call.complete(null, failure);
            throw failure;
        }
        if (result instanceof CompletionStage<?> stage) {
            stage.whenComplete((reply, failure) -> call.complete(
                    reply instanceof AsyncResultSet rows ? Integer.valueOf(rows.remaining()) : null, failure));
        } else {
            call.complete(result instanceof ResultSet rows ? Integer.valueOf(rows.getAvailableWithoutFetching()) : null, null);
        }
        return result;
    }

    private Object forward(Method method, Object[] args) throws Throwable {
        try {
            return method.invoke(session, args);
        } catch (InvocationTargetException failure) {
            throw failure.getCause();
        }
    }

    private Described describe(String call, Object first) {
        String text = null;
        String keyspace = null;
        if (first instanceof String string) {
            text = string;
        } else if (first instanceof SimpleStatement simple) {
            text = simple.getQuery();
            keyspace = simple.getKeyspace() == null ? null : simple.getKeyspace().asInternal();
        } else if (first instanceof BoundStatement bound) {
            // A bound statement is classified by the text it was prepared from, whichever session prepared it.
            text = bound.getPreparedStatement().getQuery();
        } else if (first instanceof BatchStatement batch) {
            var joined = new StringJoiner("; ", "BEGIN BATCH ", "; APPLY BATCH");
            String table = null;
            for (var child : batch) {
                String childText = child instanceof SimpleStatement simple ? simple.getQuery()
                        : child instanceof BoundStatement bound ? bound.getPreparedStatement().getQuery() : "?";
                joined.add(Partiql.sanitize(childText, true));
                if (table == null) {
                    table = tableOf(childText);
                }
            }
            return new Described(new Classified(CommandKind.WRITE, "BATCH"), table, keyspaceOf(null), joined.toString());
        }
        if (text == null) {
            // A request type this guard doesn't know: nothing says it doesn't write.
            return new Described(new Classified(CommandKind.WRITE, call.startsWith("execute") ? "UNKNOWN" : call), null, null, null);
        }
        Classified classified = StoreClassifier.cassandra(text, store.hostReads());
        String sanitized = Partiql.sanitize(text, true);
        return new Described(classified, tableOf(sanitized), keyspace != null ? keyspace : keyspaceOf(sanitized), sanitized);
    }

    private static String tableOf(String text) {
        Matcher matcher = TABLE.matcher(Partiql.sanitize(text, true));
        return matcher.find() ? unquote(matcher.group(2) != null ? matcher.group(2) : matcher.group(1)) : null;
    }

    /** The keyspace a statement names ({@code ks.table}), else the session's current one. */
    private String keyspaceOf(String text) {
        if (text != null) {
            Matcher matcher = TABLE.matcher(text);
            if (matcher.find() && matcher.group(2) != null) {
                return unquote(matcher.group(1));
            }
        }
        try {
            return session.getKeyspace().map(CqlIdentifier::asInternal).orElse(null);
        } catch (RuntimeException closed) {
            return null;
        }
    }

    private static String unquote(String identifier) {
        return identifier.length() > 1 && identifier.startsWith("\"") ? identifier.substring(1, identifier.length() - 1) : identifier;
    }
}
