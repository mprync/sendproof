package io.github.mprync.sendproof.mongodb;

import com.mongodb.MongoClientSettings;
import io.github.mprync.sendproof.core.stores.CommandKind;
import io.github.mprync.sendproof.core.stores.PreviewTransactionControlException;
import io.github.mprync.sendproof.core.RequestCapture;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.Arrays;
import org.bson.BsonDocument;
import org.bson.codecs.configuration.CodecRegistry;

/**
 * Guarded handles for the MongoDB Java drivers. No driver offers a pre-send hook, so each handle the application gets
 * is a {@link Proxy} with the driver's own interface. During a Preview every call is checked before the driver builds a
 * command:
 *
 * <ul>
 *   <li>a call without a session is routed to the driver's overload that takes the Preview session, so the command
 *       carries the Preview's {@code lsid}, {@code txnNumber} and {@code autocommit: false} ({@code preview} mode);</li>
 *   <li>an explicit session other than the Preview's is refused, failing the Preview with 500;</li>
 *   <li>the guard classifies the command the method sends and blocks writes ({@code guard} mode) or what a transaction
 *       can't run ({@code preview} mode);</li>
 *   <li>a method {@link MongoCommands} doesn't know is refused, so a new driver method fails closed;</li>
 *   <li>a handle a method returns (a database, a collection, a {@code withReadPreference} copy) is guarded too.</li>
 * </ul>
 *
 * Outside a Preview every call passes straight through.
 */
final class GuardedMongo {
    private final MongoEngine engine;
    private final MongoBackend backend;
    private final CodecRegistry registry = MongoClientSettings.getDefaultCodecRegistry();

    GuardedMongo(MongoEngine engine) {
        this.engine = engine;
        this.backend = engine.backend();
    }

    /** Guards a driver handle (client, database or collection) and everything it returns. */
    Object wrap(Object target) {
        if (target == null) {
            return null;
        }
        Class<?> type;
        Kind kind;
        if (backend.collectionType().isInstance(target)) {
            type = backend.collectionType();
            kind = Kind.COLLECTION;
        } else if (backend.databaseType().isInstance(target)) {
            type = backend.databaseType();
            kind = Kind.DATABASE;
        } else if (backend.clientType().isInstance(target)) {
            type = backend.clientType();
            kind = Kind.CLIENT;
        } else if (backend.clusterType().isInstance(target)) {
            type = backend.clusterType();
            kind = Kind.CLIENT;
        } else {
            return target;
        }
        return Proxy.newProxyInstance(GuardedMongo.class.getClassLoader(), new Class<?>[] {type},
                new Handler(target, kind));
    }

    private enum Kind { CLIENT, DATABASE, COLLECTION }

    private final class Handler implements InvocationHandler {
        private final Object target;
        private final Kind kind;

        Handler(Object target, Kind kind) {
            this.target = target;
            this.kind = kind;
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
            if (kind == Kind.CLIENT && name.equals("startSession")) {
                MongoEngine.PreviewState state = engine.state();
                if (state != null) {
                    return backend.returned(state.guardedSession());
                }
            }
            RequestCapture preview = StoreGuard.currentPreview();
            if (preview == null || MongoCommands.inert(name)) {
                return call(method, target, engine.driverSessions(args));
            }
            MongoCommands.Rule rule = switch (kind) {
                case COLLECTION -> MongoCommands.collection(name);
                case DATABASE -> MongoCommands.database(method);
                case CLIENT -> MongoCommands.client(method);
            };
            if (rule == null) {
                if (producesHandle(method) || name.equals("startSession") || name.equals("withSession")) {
                    return call(method, target, args);
                }
                // A method this guard doesn't know: refuse it in a Preview rather than let it escape.
                StoreGuard.guard("mongodb", name, CommandKind.WRITE, StoreGuard.refusedReason(name));
                return null;
            }
            String database = databaseName();
            String collection = kind == Kind.COLLECTION ? collectionName() : database;
            BsonDocument command = rule.command(collection, args, registry);
            String operation = command.isEmpty() ? name : command.keySet().iterator().next();
            engine.check(command, operation, database);
            MongoEngine.PreviewState state = engine.state();
            if (state == null || MongoEngine.systemDatabase(database)) {
                return call(method, target, args);
            }
            return callInSession(method, args, state);
        }

        private boolean producesHandle(Method method) {
            Class<?> type = method.getReturnType();
            return backend.collectionType().isAssignableFrom(type) || backend.databaseType().isAssignableFrom(type)
                    || backend.clientType().isAssignableFrom(type) || backend.clusterType().isAssignableFrom(type);
        }

        /**
         * Calls the driver's overload that takes the Preview session, or refuses a session that isn't the Preview's. The
         * driver always gets the driver's session (see {@link PreviewSessions}), never the handler's.
         */
        private Object callInSession(Method method, Object[] args, MongoEngine.PreviewState state) throws Throwable {
            Class<?>[] parameters = method.getParameterTypes();
            if (parameters.length > 0 && backend.sessionType().isAssignableFrom(parameters[0])) {
                Object given = args[0];
                if (given != null && given != state.guardedSession() && given != state.driverSession()) {
                    throw refuse("A MongoDB call passed its own session during a Preview; the Preview session must carry every command.");
                }
                Object[] swapped = args.clone();
                swapped[0] = state.driverSession();
                return call(method, target, swapped);
            }
            Class<?>[] withSession = new Class<?>[parameters.length + 1];
            withSession[0] = backend.sessionType();
            System.arraycopy(parameters, 0, withSession, 1, parameters.length);
            Method overload;
            try {
                overload = method.getDeclaringClass().getMethod(method.getName(), withSession);
            } catch (NoSuchMethodException none) {
                // Without a session overload the command could not join the transaction: fail closed.
                throw refuse("MongoDB " + method.getName() + " can't join the Preview transaction.");
            }
            Object[] sessionArgs = new Object[args == null ? 1 : args.length + 1];
            sessionArgs[0] = state.driverSession();
            if (args != null) {
                System.arraycopy(args, 0, sessionArgs, 1, args.length);
            }
            return call(overload, target, sessionArgs);
        }

        private PreviewTransactionControlException refuse(String message) {
            PreviewTransactionControlException refusal = StoreGuard.refuseInPreview(message);
            return refusal != null ? refusal : new PreviewTransactionControlException(message);
        }

        private Object call(Method method, Object receiver, Object[] args) throws Throwable {
            try {
                return wrap(method.invoke(receiver, args));
            } catch (InvocationTargetException failure) {
                throw failure.getCause();
            }
        }

        private String databaseName() {
            return switch (kind) {
                case CLIENT -> null;
                case DATABASE -> (String) read(backend.databaseType(), "getName");
                case COLLECTION -> ((com.mongodb.MongoNamespace) read(backend.collectionType(), "getNamespace")).getDatabaseName();
            };
        }

        private String collectionName() {
            return ((com.mongodb.MongoNamespace) read(backend.collectionType(), "getNamespace")).getCollectionName();
        }

        private Object read(Class<?> type, String getter) {
            try {
                return type.getMethod(getter).invoke(target);
            } catch (ReflectiveOperationException error) {
                throw new IllegalStateException("Could not read " + getter + " from " + Arrays.toString(type.getInterfaces()), error);
            }
        }
    }
}
