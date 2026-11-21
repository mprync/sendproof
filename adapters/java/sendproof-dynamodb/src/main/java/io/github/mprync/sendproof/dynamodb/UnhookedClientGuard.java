package io.github.mprync.sendproof.dynamodb;

import io.github.mprync.sendproof.core.stores.CommandKind;
import io.github.mprync.sendproof.core.stores.StoreClassifier;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import java.util.concurrent.atomic.AtomicBoolean;
import software.amazon.awssdk.core.interceptor.Context;
import software.amazon.awssdk.core.interceptor.ExecutionAttributes;
import software.amazon.awssdk.core.interceptor.ExecutionInterceptor;

/**
 * The write guard for DynamoDB clients built without a {@link DynamoDbStore}, such as one a handler builds for itself.
 *
 * <p>The AWS SDK for Java v2 adds the interceptors listed in
 * {@code software/amazon/awssdk/services/dynamodb/execution.interceptors} on the classpath to every DynamoDB client it
 * builds, and this module lists this class there. So no client built in a process that has this module, before or
 * after the application's own, can write during a Preview: an unhooked write is refused before it is marshalled, the
 * same way the store refuses it. Calls a {@code DynamoDbStore} already saw are left to that store, so its
 * {@code treatAsRead} names still apply on its own clients. Outside a Preview it does nothing.
 *
 * <p>The SDK creates this class itself; applications never need to.
 */
public final class UnhookedClientGuard implements ExecutionInterceptor {
    /** Lets a test remove the hook to show the guard checks fail without it. */
    static final AtomicBoolean ENABLED = new AtomicBoolean(true);

    /** Called by the SDK. */
    public UnhookedClientGuard() {
    }

    /**
     * Runs after every interceptor's {@code beforeExecution}, so a {@link DynamoDbStore} on the same client has marked the
     * call by now, and before the request is marshalled, signed or sent.
     */
    @Override
    public void beforeMarshalling(Context.BeforeMarshalling context, ExecutionAttributes attributes) {
        if (!ENABLED.get() || Boolean.TRUE.equals(attributes.getAttribute(DynamoDbStore.HOOKED))) {
            return;
        }
        String operation = DynamoDbStore.operation(context.request(), attributes);
        CommandKind kind = StoreClassifier.dynamo(operation, DynamoDbStore.statements(context.request()), null);
        StoreGuard.guard("dynamodb", operation, kind, null);
    }
}
