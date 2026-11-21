package io.github.mprync.sendproof.redis;

import io.github.mprync.sendproof.core.stores.CommandKind;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.aopalliance.intercept.MethodInterceptor;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.data.redis.connection.RedisConnection;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.util.ClassUtils;

/**
 * The Spring Data Redis hook. A {@code RedisConnectionFactory} is decorated (a CGLIB subclass of its own class, so the
 * bean keeps its type and lifecycle) so that {@code getConnection()} returns a {@link Proxy} over the real
 * {@code RedisConnection}. Each call is mapped to its Redis command by name (a camel-case method is the upper-cased
 * command: {@code hGetAll} is {@code HGETALL}), classified, and refused before it reaches the client when it writes.
 * A method the mapping doesn't know is a command the table doesn't list, so it is a write: the guard fails closed.
 */
final class SpringRedis {
    /** Methods that are neither commands nor command groups. */
    private static final Set<String> INERT = Set.of("close", "isClosed", "isQueueing", "isPipelined",
            "openPipeline", "closePipeline", "isSubscribed", "getSubscription", "hashCode", "equals", "toString",
            "getSentinelConnection", "getDelegate");

    /** Methods whose Redis command is not their upper-cased name: command, then sub-command. */
    private static final Map<String, String[]> ALIASES = Map.ofEntries(
            Map.entry("encodingOf", new String[] {"OBJECT", "ENCODING"}), Map.entry("idletime", new String[] {"OBJECT", "IDLETIME"}),
            Map.entry("refcount", new String[] {"OBJECT", "REFCOUNT"}), Map.entry("getConfig", new String[] {"CONFIG", "GET"}),
            Map.entry("setConfig", new String[] {"CONFIG", "SET"}), Map.entry("resetConfigStats", new String[] {"CONFIG", "RESETSTAT"}),
            Map.entry("rewriteConfig", new String[] {"CONFIG", "REWRITE"}), Map.entry("scriptExists", new String[] {"SCRIPT", "EXISTS"}),
            Map.entry("scriptLoad", new String[] {"SCRIPT", "LOAD"}), Map.entry("scriptFlush", new String[] {"SCRIPT", "FLUSH"}),
            Map.entry("scriptKill", new String[] {"SCRIPT", "KILL"}), Map.entry("setClientName", new String[] {"CLIENT", "SETNAME"}),
            Map.entry("getClientName", new String[] {"CLIENT", "GETNAME"}), Map.entry("getClientList", new String[] {"CLIENT", "LIST"}),
            Map.entry("killClient", new String[] {"CLIENT", "KILL"}), Map.entry("xInfo", new String[] {"XINFO", "STREAM"}),
            Map.entry("xInfoGroups", new String[] {"XINFO", "GROUPS"}), Map.entry("xInfoConsumers", new String[] {"XINFO", "CONSUMERS"}),
            Map.entry("eval", new String[] {"EVAL"}), Map.entry("evalSha", new String[] {"EVALSHA"}),
            Map.entry("select", new String[] {"SELECT"}), Map.entry("slaveOf", new String[] {"SLAVEOF"}));

    private SpringRedis() {
    }

    /** Decorates a connection factory. */
    @SuppressWarnings("unchecked")
    static <F> F guard(RedisStore store, F factory) {
        if (!(factory instanceof RedisConnectionFactory)) {
            throw new IllegalArgumentException("RedisStore.spring takes a Spring Data RedisConnectionFactory.");
        }
        var proxies = new ProxyFactory(factory);
        proxies.setProxyTargetClass(true);
        proxies.addAdvice((MethodInterceptor) invocation -> {
            Method method = invocation.getMethod();
            String name = method.getName();
            if ((name.equals("getReactiveConnection") || name.equals("getReactiveClusterConnection"))
                    && StoreGuard.currentPreview() != null) {
                // A reactive connection can't be guarded: refuse rather than let its writes escape.
                throw StoreGuard.refuseInPreview("Reactive Redis access isn't guarded, so the Preview can't be confirmed.");
            }
            Object result = invocation.proceed();
            if ((name.equals("getConnection") || name.equals("getClusterConnection")) && result instanceof RedisConnection connection) {
                return connection(store, connection, new Queue(connection));
            }
            return result;
        });
        return (F) proxies.getProxy(factory.getClass().getClassLoader());
    }

    /**
     * Wraps a connection, or any command group it returns, in a guarding {@link Proxy}. A connection and its command
     * groups share one {@link Queue}, so a write refused through a group still discards the connection's {@code MULTI}.
     */
    private static <T> T connection(RedisStore store, T target, Queue queue) {
        Class<?>[] interfaces = ClassUtils.getAllInterfacesForClass(target.getClass(), target.getClass().getClassLoader());
        return castProxy(Proxy.newProxyInstance(target.getClass().getClassLoader(), interfaces, new Guarding(store, target, queue)));
    }

    /** The {@code MULTI} state of one connection, shared by the proxies of the connection and its command groups. */
    private static final class Queue {
        private final Object connection;
        /** Whether a {@code MULTI} is open on the connection and not yet executed or discarded. */
        private boolean multi;

        Queue(Object connection) {
            this.connection = connection;
        }

        /** A refused write inside {@code MULTI}: nothing queued runs until {@code EXEC}, so discard what was queued. */
        synchronized void discardIfQueueing() {
            if (multi) {
                multi = false;
                try {
                    connection.getClass().getMethod("discard").invoke(connection);
                } catch (ReflectiveOperationException | RuntimeException ignored) {
                    // The caller closes the connection after the refusal, which discards the queue as well.
                }
            }
        }

        synchronized void transaction(String method) {
            if (method.equals("multi")) {
                multi = true;
            } else if (method.equals("exec") || method.equals("discard")) {
                multi = false;
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static <T> T castProxy(Object proxy) {
        return (T) proxy;
    }

    private static final class Guarding implements InvocationHandler {
        private final RedisStore store;
        private final Object target;
        private final Queue queue;

        Guarding(RedisStore store, Object target, Queue queue) {
            this.store = store;
            this.target = target;
            this.queue = queue;
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            String name = method.getName();
            if (method.getDeclaringClass() == Object.class) {
                return switch (name) {
                    case "equals" -> proxy == args[0];
                    case "hashCode" -> System.identityHashCode(proxy);
                    default -> "Sendproof guarded " + target;
                };
            }
            if (INERT.contains(name)) {
                return call(method, args);
            }
            if (name.equals("getNativeConnection")) {
                // The raw Lettuce or Jedis connection sends commands around this guard.
                if (StoreGuard.currentPreview() != null) {
                    throw StoreGuard.refuseInPreview("The native Redis connection isn't guarded, so the Preview can't be confirmed.");
                }
                return call(method, args);
            }
            if (name.equals("commands") && (args == null || args.length == 0)) {
                // RedisConnection.commands() returns the connection itself: hand back this guarded view, never the target.
                return proxy;
            }
            if (name.endsWith("Commands") && (args == null || args.length == 0) && method.getReturnType().isInterface()) {
                Object group = call(method, args);
                return group == null ? null : group == target ? proxy : connection(store, group, queue);
            }
            String command;
            List<Object> arguments = flatten(args);
            String[] alias = ALIASES.get(name);
            if (name.equals("execute") && args != null && args.length > 0 && args[0] instanceof String raw) {
                command = raw;
                arguments = flatten(args.length > 1 ? java.util.Arrays.copyOfRange(args, 1, args.length) : new Object[0]);
            } else if (alias != null) {
                command = alias[0];
                if (alias.length > 1) {
                    arguments.add(0, alias[1]);
                }
            } else {
                command = name.toUpperCase(java.util.Locale.ROOT);
            }
            CommandKind kind;
            try {
                kind = store.check(command, arguments);
            } catch (RuntimeException refused) {
                queue.discardIfQueueing();
                throw refused;
            }
            if (kind == CommandKind.SESSION) {
                return call(method, args);
            }
            if (kind == CommandKind.TRANSACTION) {
                queue.transaction(name);
            }
            var capture = RedisStore.capture();
            long started = System.nanoTime();
            try {
                Object result = call(method, args);
                RedisStore.record(capture, command, arguments, started, null);
                return result;
            } catch (Throwable failure) {
                RedisStore.record(capture, command, arguments, started, failure);
                throw failure;
            }
        }

        private Object call(Method method, Object[] args) throws Throwable {
            try {
                return method.invoke(target, args);
            } catch (InvocationTargetException failure) {
                throw failure.getCause();
            }
        }

        /** Flattens arrays and collections of arguments, as the clients do before sending. */
        private static List<Object> flatten(Object[] args) {
            var flat = new ArrayList<Object>();
            if (args != null) {
                for (Object argument : args) {
                    add(flat, argument);
                }
            }
            return flat;
        }

        private static void add(List<Object> flat, Object argument) {
            if (argument == null) {
                return;
            }
            if (argument instanceof byte[]) {
                flat.add(argument);
            } else if (argument instanceof Object[] array) {
                for (Object item : array) {
                    add(flat, item);
                }
            } else if (argument instanceof Collection<?> collection) {
                for (Object item : collection) {
                    add(flat, item);
                }
            } else if (argument instanceof Map<?, ?> map) {
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    add(flat, entry.getKey());
                    add(flat, entry.getValue());
                }
            } else {
                flat.add(argument);
            }
        }
    }
}
