package io.github.mprync.sendproof.core.stores;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Write classification for the batch-one data stores, driven by the shared tables in {@code spec/data-stores/}.
 * Each table lists reads and connection-level commands; everything else, including a command the table has never
 * heard of, is a write, so the guard fails closed when a store adds a command.
 *
 * <p>Every method is pure. The shared vectors in {@code classification-cases.json} run through them in
 * {@code StoreClassifierTest}.
 */
public final class StoreClassifier {
    private static final Set<String> WRITING_STAGES = Set.of("$out", "$merge");

    private StoreClassifier() {
    }

    /** The result of classifying a MongoDB command document. */
    public record MongoClassification(CommandKind kind, String refusedInTransaction) {
    }

    /**
     * Classifies a Redis command. {@code name} is the command name in any case and {@code arguments} its arguments, of
     * which only the first is read, to form {@code CONTAINER|SUBCOMMAND} keys such as {@code OBJECT|ENCODING}.
     *
     * @param treatAsRead host-declared reads, compared exactly against the upper-case key, or {@code null}
     */
    public static CommandKind redis(String name, List<?> arguments, Set<String> treatAsRead) {
        StoreTables.Redis table = StoreTables.redis();
        String command = name.toUpperCase(Locale.ROOT);
        String withSub = arguments == null || arguments.isEmpty() ? command
                : command + "|" + text(arguments.get(0)).toUpperCase(Locale.ROOT);
        for (String key : new String[] {withSub, command}) {
            if (table.session().contains(key)) {
                return CommandKind.SESSION;
            }
            if (table.transaction().contains(key)) {
                return CommandKind.TRANSACTION;
            }
            if (table.read().contains(key) || (treatAsRead != null && treatAsRead.contains(key))) {
                return CommandKind.READ;
            }
        }
        return CommandKind.WRITE;
    }

    /**
     * Classifies a MongoDB command document by its first key, case-insensitively. {@code aggregate} is a write when
     * any stage at any depth is {@code $out} or {@code $merge}; {@code explain} takes the classification of the command
     * inside it. {@code refusedInTransaction} names what a {@code preview}-mode Preview must block first.
     *
     * <p>The command is any {@link Map} with ordered keys, including a {@code BsonDocument}; nested maps and lists are
     * walked as they are.
     *
     * @param treatAsRead host-declared reads in lower case, or {@code null}
     */
    public static MongoClassification mongo(Map<?, ?> command, Set<String> treatAsRead) {
        StoreTables.Mongo table = StoreTables.mongo();
        if (command == null || command.isEmpty()) {
            return new MongoClassification(CommandKind.WRITE, null);
        }
        Object first = command.keySet().iterator().next();
        String name = String.valueOf(first);
        String lower = name.toLowerCase(Locale.ROOT);
        Object value = command.get(first);
        if (lower.equals("explain") && value instanceof Map<?, ?> inner) {
            return mongo(inner, treatAsRead);
        }
        String refused = null;
        if (table.notInTransactionCommands().contains(lower)) {
            refused = name;
        }
        Object pipeline = get(command, "pipeline");
        if (lower.equals("aggregate")) {
            for (String stage : table.notInTransactionStages()) {
                if (uses(pipeline, Set.of(stage))) {
                    refused = stage;
                    break;
                }
            }
        }
        if (table.session().contains(lower)) {
            return new MongoClassification(CommandKind.SESSION, null);
        }
        if (lower.equals("aggregate") && uses(pipeline, WRITING_STAGES)) {
            return new MongoClassification(CommandKind.WRITE, refused);
        }
        if (table.read().contains(lower) || (treatAsRead != null && treatAsRead.contains(lower))) {
            return new MongoClassification(CommandKind.READ, refused);
        }
        return new MongoClassification(CommandKind.WRITE, refused);
    }

    /**
     * Classifies a DynamoDB action. A PartiQL action is a read only when every statement in the request is a
     * {@code SELECT}.
     *
     * @param statements the PartiQL statements the request carries; ignored for other actions
     * @param treatAsRead host-declared action names, matched exactly, or {@code null}
     */
    public static CommandKind dynamo(String operation, List<String> statements, Set<String> treatAsRead) {
        StoreTables.Dynamo table = StoreTables.dynamo();
        if (table.read().contains(operation) || (treatAsRead != null && treatAsRead.contains(operation))) {
            return CommandKind.READ;
        }
        if (table.partiql().contains(operation)) {
            boolean selects = statements != null && !statements.isEmpty()
                    && statements.stream().allMatch(statement -> Partiql.verb(statement).equals("SELECT"));
            return selects ? CommandKind.READ : CommandKind.WRITE;
        }
        return CommandKind.WRITE;
    }

    /** Classifies a DynamoDB action given as a JSON-like request, as the shared vectors give it. */
    public static CommandKind dynamo(String operation, Map<?, ?> input, Set<String> treatAsRead) {
        var statements = new ArrayList<String>();
        if (input != null) {
            Object single = input.get("Statement");
            if (operation.equals("ExecuteStatement")) {
                statements.add(single == null ? null : String.valueOf(single));
            } else {
                Object list = input.containsKey("Statements") ? input.get("Statements") : input.get("TransactStatements");
                if (list instanceof Iterable<?> items) {
                    for (Object item : items) {
                        Object statement = item instanceof Map<?, ?> map ? map.get("Statement") : null;
                        statements.add(statement == null ? null : String.valueOf(statement));
                    }
                }
            }
        }
        return dynamo(operation, statements, treatAsRead);
    }

    /** Whether any key of an aggregation pipeline, at any depth (sub-pipelines included), is in {@code stages}. */
    static boolean uses(Object value, Set<String> stages) {
        if (value instanceof Map<?, ?> map) {
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (stages.contains(String.valueOf(entry.getKey())) || uses(entry.getValue(), stages)) {
                    return true;
                }
            }
        } else if (value instanceof Iterable<?> items) {
            for (Object item : items) {
                if (uses(item, stages)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static Object get(Map<?, ?> map, String key) {
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            if (key.equals(String.valueOf(entry.getKey()))) {
                return entry.getValue();
            }
        }
        return null;
    }

    private static String text(Object value) {
        return value instanceof byte[] bytes ? new String(bytes, java.nio.charset.StandardCharsets.UTF_8) : String.valueOf(value);
    }
}
