package io.github.mprync.sendproof.dynamodb;

import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.DataStore;
import io.github.mprync.sendproof.core.DbEntry;
import io.github.mprync.sendproof.core.RequestCapture;
import io.github.mprync.sendproof.core.stores.CommandKind;
import io.github.mprync.sendproof.core.stores.Partiql;
import io.github.mprync.sendproof.core.stores.StoreClassifier;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import software.amazon.awssdk.core.SdkRequest;
import software.amazon.awssdk.core.SdkResponse;
import software.amazon.awssdk.core.interceptor.Context;
import software.amazon.awssdk.core.interceptor.ExecutionAttribute;
import software.amazon.awssdk.core.interceptor.ExecutionAttributes;
import software.amazon.awssdk.core.interceptor.ExecutionInterceptor;
import software.amazon.awssdk.core.interceptor.SdkExecutionAttribute;

/**
 * Sendproof write guard for DynamoDB ({@code guard} mode of {@code spec/data-stores.md}).
 *
 * <p>Register one instance as an execution interceptor on each DynamoDB client of the application:
 *
 * <pre>{@code
 * DynamoDbStore orders = DynamoDbStore.interceptor().name("orders").build();
 * DynamoDbClient client = DynamoDbClient.builder()
 *         .overrideConfiguration(c -> c.addExecutionInterceptor(orders))
 *         .build();
 * }</pre>
 *
 * <p>{@code beforeExecution} runs before the request is serialized and signed, so a refused command never becomes an HTTP
 * request, and credentials, the {@code Authorization} header and signatures never reach the hook. The operation is the
 * SDK's operation name ({@code UpdateItem}). The Enhanced Client calls the same low-level client, so hooking that client
 * covers both. A client built without the interceptor is not covered: its writes are not blocked.
 */
public final class DynamoDbStore implements DataStore, ExecutionInterceptor {
    private static final ExecutionAttribute<Call> CALL = new ExecutionAttribute<>("SendproofDynamoDbCall");
    private static final Pattern QUOTED = Pattern.compile("\"([^\"]+)\"");

    private final String name;
    private final Set<String> reads;

    /** What the interceptor remembers between {@code beforeExecution} and the reply. */
    private record Call(RequestCapture capture, String operation, String target, String statement, long startedNanos) {
    }

    private DynamoDbStore(Builder builder) {
        this.name = builder.name;
        this.reads = builder.reads;
    }

    /** Starts a store configuration. */
    public static Builder interceptor() {
        return new Builder();
    }

    /** Configures a {@link DynamoDbStore}. */
    public static final class Builder {
        private String name;
        private Set<String> reads;

        private Builder() {
        }

        /** A display label for discovery such as {@code orders}; never an endpoint or ARN. */
        public Builder name(String label) {
            this.name = StoreGuard.storeLabel(label);
            return this;
        }

        /**
         * Action names the host states never write, matched exactly without wildcards. This is the host's statement: an
         * action wrongly listed here is not blocked.
         */
        public Builder treatAsRead(String... actions) {
            this.reads = StoreGuard.readSet(java.util.Arrays.asList(actions), action -> action);
            return this;
        }

        /** Builds the store, which is also the interceptor to register on the client. */
        public DynamoDbStore build() {
            return new DynamoDbStore(this);
        }
    }

    @Override
    public String system() {
        return "dynamodb";
    }

    @Override
    public Description describe() {
        return new Description("dynamodb", name, "guard", null);
    }

    @Override
    public void beforeExecution(Context.BeforeExecution context, ExecutionAttributes attributes) {
        String operation = attributes.getAttribute(SdkExecutionAttribute.OPERATION_NAME);
        if (operation == null) {
            operation = context.request().getClass().getSimpleName().replaceFirst("Request$", "");
        }
        SdkRequest request = context.request();
        List<String> statements = statements(request);
        CommandKind kind = StoreClassifier.dynamo(operation, statements, reads);
        StoreGuard.guard("dynamodb", operation, kind, null);
        RequestCapture capture = CaptureContext.current();
        if (capture == null) {
            return;
        }
        String statement = statements.isEmpty() ? null
                : String.join("; ", statements.stream().map(text -> Partiql.sanitize(text == null ? "" : text)).toList());
        attributes.putAttribute(CALL, new Call(capture, operation, target(request, statement), statement, System.nanoTime()));
    }

    @Override
    public void afterExecution(Context.AfterExecution context, ExecutionAttributes attributes) {
        record(attributes, rows(context.response()), null);
    }

    @Override
    public void onExecutionFailure(Context.FailedExecution context, ExecutionAttributes attributes) {
        Throwable failure = context.exception();
        record(attributes, null, failure == null ? "Error" : failure.getClass().getSimpleName());
    }

    private static void record(ExecutionAttributes attributes, Integer rows, String error) {
        Call call = attributes.getAttribute(CALL);
        if (call == null) {
            return;
        }
        DbEntry entry = DbEntry.of("dynamodb", call.operation()).withRows(rows).withError(error)
                .withElapsed((System.nanoTime() - call.startedNanos()) / 1_000_000.0);
        if (call.target() != null) {
            entry = entry.withTarget(call.target());
        }
        if (call.statement() != null) {
            entry = entry.withStatement(call.statement());
        }
        call.capture().db(entry);
    }

    /** The PartiQL statements a request carries; empty for any other action. */
    private static List<String> statements(SdkRequest request) {
        var statements = new ArrayList<String>();
        Optional<String> single = request.getValueForField("Statement", String.class);
        single.ifPresent(statements::add);
        for (String field : new String[] {"Statements", "TransactStatements"}) {
            Optional<List> list = request.getValueForField(field, List.class);
            if (list.isPresent()) {
                for (Object item : list.get()) {
                    if (item instanceof software.amazon.awssdk.core.SdkPojo pojo) {
                        statements.add(pojo.sdkFields().stream().filter(entry -> "Statement".equals(entry.locationName()))
                                .findFirst().map(entry -> (String) entry.getValueOrDefault(pojo)).orElse(null));
                    }
                }
            }
        }
        return statements;
    }

    /** The table a command targets: {@code TableName}, the first {@code RequestItems} table, or the quoted PartiQL table. */
    private static String target(SdkRequest request, String statement) {
        Optional<String> table = request.getValueForField("TableName", String.class);
        if (table.isPresent()) {
            return table.get();
        }
        Optional<Map> items = request.getValueForField("RequestItems", Map.class);
        if (items.isPresent() && !items.get().isEmpty()) {
            return String.valueOf(items.get().keySet().iterator().next());
        }
        if (statement != null) {
            Matcher matcher = QUOTED.matcher(statement);
            if (matcher.find()) {
                return matcher.group(1);
            }
        }
        return null;
    }

    /** Items matched, returned or written, when the reply says so. */
    private static Integer rows(SdkResponse response) {
        if (response == null) {
            return null;
        }
        Optional<Integer> count = response.getValueForField("Count", Integer.class);
        if (count.isPresent()) {
            return count.get();
        }
        Optional<List> items = response.getValueForField("Items", List.class);
        if (items.isPresent()) {
            return items.get().size();
        }
        for (String field : new String[] {"Item", "Attributes"}) {
            Optional<Object> value = response.getValueForField(field, Object.class);
            if (value.isPresent() && !(value.get() instanceof Collection<?> collection && collection.isEmpty())
                    && !(value.get() instanceof Map<?, ?> map && map.isEmpty())) {
                return 1;
            }
        }
        return null;
    }
}
