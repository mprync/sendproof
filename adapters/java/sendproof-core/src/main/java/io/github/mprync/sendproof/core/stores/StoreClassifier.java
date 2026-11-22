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

    /**
     * A batch-two classification: how the guard treats the command, and the {@code db.operation.name} it is logged under.
     *
     * @param kind      {@link CommandKind#READ}, {@link CommandKind#WRITE} or {@link CommandKind#SESSION} (allowed, never logged)
     * @param operation the operation name the {@code Db} entry and the 409 body use
     */
    public record Classified(CommandKind kind, String operation) {
    }

    /** A host-declared read turns a write-classified operation into a read; it never overrides anything else. */
    private static Classified withHostReads(Classified classified, Set<String> treatAsRead) {
        return classified.kind() == CommandKind.WRITE && treatAsRead != null && treatAsRead.contains(classified.operation())
                ? new Classified(CommandKind.READ, classified.operation()) : classified;
    }

    // ---- Cassandra ----

    /**
     * Classifies one CQL statement by its first keyword ({@code LIST} takes its next word too). It is a read only when the
     * whole text is one well-formed statement whose key the table lists. A {@code BEGIN … BATCH} is named {@code BATCH},
     * a lightweight transaction ({@code IF NOT EXISTS}) is a write because only {@code SELECT}, {@code USE},
     * {@code DESCRIBE} and {@code LIST} read, and text the guard can't read is named {@code UNKNOWN} and is a write.
     *
     * @param treatAsRead host-declared first keywords (upper case), honoured only for a single well-formed statement
     */
    public static Classified cassandra(String statement, Set<String> treatAsRead) {
        StatementShape shape = StatementShape.of(statement, false, true, true);
        String key = shape.first().equals("LIST") ? "LIST " + shape.second() : shape.first();
        String operation = shape.first().equals("BEGIN") ? "BATCH" : shape.first().isEmpty() ? "UNKNOWN" : key;
        boolean single = !shape.broken() && !shape.multiple();
        if (single && StoreTables.cassandra().read().contains(key)) {
            return new Classified(CommandKind.READ, operation);
        }
        Classified write = new Classified(CommandKind.WRITE, operation);
        return single && !operation.equals("BATCH") ? withHostReads(write, treatAsRead) : write;
    }

    /**
     * Classifies a CQL native-protocol message: connection messages and {@code PREPARE} are session, {@code QUERY}
     * classifies its text, {@code EXECUTE} classifies the text that was prepared (an id never seen prepared is a write)
     * and every {@code BATCH} is a write.
     *
     * @param statement the QUERY text, or {@code null}
     * @param prepared  the text an EXECUTE's id was prepared from, or {@code null} when the hook never saw it prepared
     */
    public static Classified cassandraMessage(String message, String statement, String prepared, Set<String> treatAsRead) {
        if (StoreTables.cassandra().sessionMessages().contains(message)) {
            return new Classified(CommandKind.SESSION, message);
        }
        if (message.equals("QUERY")) {
            return cassandra(statement, treatAsRead);
        }
        if (message.equals("EXECUTE")) {
            return prepared == null ? new Classified(CommandKind.WRITE, "EXECUTE") : cassandra(prepared, treatAsRead);
        }
        return new Classified(CommandKind.WRITE, message);
    }

    // ---- Elasticsearch and OpenSearch ----

    /**
     * Splits a request path into its percent-decoded segments, without the query string and with repeated and trailing
     * slashes dropped, the way the server matches it.
     */
    static List<String> segments(String path) {
        String bare = path == null ? "" : path;
        int query = bare.indexOf('?');
        if (query >= 0) {
            bare = bare.substring(0, query);
        }
        var segments = new ArrayList<String>();
        for (String part : bare.split("/")) {
            if (!part.isEmpty()) {
                try {
                    segments.add(java.net.URLDecoder.decode(part.replace("+", "%2B"), java.nio.charset.StandardCharsets.UTF_8));
                } catch (IllegalArgumentException malformed) {
                    segments.add(part);
                }
            }
        }
        return segments;
    }

    private static boolean segmentMatches(String pattern, String segment) {
        return switch (pattern) {
            case "{index}" -> !segment.isEmpty() && !segment.startsWith("_");
            case "{id}" -> !segment.isEmpty();
            default -> pattern.equals(segment);
        };
    }

    /**
     * Classifies an Elasticsearch or OpenSearch request by HTTP method and path. The table's endpoints are tried in order
     * and the first whose method and path match decides; {@code GET} and {@code HEAD} read on any other path and
     * everything else is a write. A {@code sql} endpoint reads only when the body's {@code query} is one {@code SELECT},
     * {@code SHOW} or {@code DESCRIBE} statement, or the body only carries a cursor.
     *
     * @param path  the path, with or without a query string; the client's path prefix is already removed
     * @param body  the request body as a {@code String} of JSON, a {@code Map}, a {@code JsonNode}, or {@code null}
     * @param treatAsRead host-declared operation names, matched exactly, or {@code null}
     */
    public static Classified search(String method, String path, Object body, Set<String> treatAsRead) {
        StoreTables.Search table = StoreTables.search();
        String verb = method.toUpperCase(Locale.ROOT);
        List<String> parts = segments(path);
        for (StoreTables.Endpoint entry : table.endpoints()) {
            if (!entry.methods().contains(verb)) {
                continue;
            }
            boolean hit = false;
            for (List<String> pattern : entry.paths()) {
                if (pattern.size() == parts.size()) {
                    boolean all = true;
                    for (int i = 0; i < pattern.size() && all; i++) {
                        all = segmentMatches(pattern.get(i), parts.get(i));
                    }
                    if (all) {
                        hit = true;
                        break;
                    }
                }
            }
            if (!hit) {
                continue;
            }
            CommandKind kind = switch (entry.kind()) {
                case "read" -> CommandKind.READ;
                case "session" -> CommandKind.SESSION;
                case "sql" -> sqlReads(body, table.sqlReadWords()) ? CommandKind.READ : CommandKind.WRITE;
                default -> CommandKind.WRITE;
            };
            return withHostReads(new Classified(kind, entry.name()), treatAsRead);
        }
        var name = new StringBuilder(verb).append(" /");
        for (int i = 0; i < parts.size(); i++) {
            name.append(i > 0 ? "/" : "").append(parts.get(i).startsWith("_") ? parts.get(i) : "{}");
        }
        String fallback = table.methodDefault().getOrDefault(verb, table.defaultKind());
        return withHostReads(new Classified(fallback.equals("read") ? CommandKind.READ : CommandKind.WRITE, name.toString()),
                treatAsRead);
    }

    /** The index a request path names (its first segment when that isn't an endpoint), for {@code db.collection.name}. */
    public static String searchTarget(String path) {
        List<String> parts = segments(path);
        return !parts.isEmpty() && !parts.get(0).startsWith("_") ? parts.get(0) : null;
    }

    private static boolean sqlReads(Object body, Set<String> readWords) {
        com.fasterxml.jackson.databind.JsonNode parsed;
        try {
            parsed = body instanceof String text ? io.github.mprync.sendproof.core.Json.MAPPER.readTree(text)
                    : body instanceof com.fasterxml.jackson.databind.JsonNode node ? node
                    : body == null ? null : io.github.mprync.sendproof.core.Json.MAPPER.valueToTree(body);
        } catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException notJson) {
            return false;
        }
        if (parsed == null || !parsed.isObject()) {
            return false;
        }
        com.fasterxml.jackson.databind.JsonNode query = parsed.get("query");
        if (query != null && !query.isNull()) {
            if (!query.isTextual()) {
                return false;
            }
            StatementShape shape = StatementShape.of(query.asText(), true, false, false);
            return !shape.broken() && !shape.multiple() && readWords.contains(shape.first());
        }
        return parsed.has("cursor") && parsed.get("cursor").isTextual();
    }

    // ---- Cosmos DB ----

    private static boolean truthy(Object value) {
        return value != null && String.valueOf(value).equalsIgnoreCase("true");
    }

    private static Object header(Map<String, ?> headers, String name) {
        if (headers != null) {
            for (Map.Entry<String, ?> entry : headers.entrySet()) {
                if (entry.getKey() != null && entry.getKey().equalsIgnoreCase(name)) {
                    return entry.getValue();
                }
            }
        }
        return null;
    }

    /** Derives a Cosmos DB operation type from an HTTP request, as {@code fromRequest} in the table lists. */
    public static String cosmosOperation(String method, String path, Map<String, ?> headers) {
        List<String> parts = segments(path);
        boolean one = !parts.isEmpty() && parts.size() % 2 == 0;
        String verb = method.toUpperCase(Locale.ROOT);
        switch (verb) {
            case "GET":
                return one ? "Read" : "ReadFeed";
            case "HEAD":
                return one ? "Head" : "HeadFeed";
            case "POST":
                if (truthy(header(headers, "x-ms-cosmos-is-query-plan-request"))) {
                    return "QueryPlan";
                }
                Object contentType = header(headers, "content-type");
                if (truthy(header(headers, "x-ms-documentdb-isquery"))
                        || (contentType != null && String.valueOf(contentType).toLowerCase(Locale.ROOT).startsWith("application/query+json"))) {
                    return "Query";
                }
                if (truthy(header(headers, "x-ms-cosmos-is-batch-request"))) {
                    return "Batch";
                }
                if (one && parts.get(parts.size() - 2).equals("sprocs")) {
                    return "ExecuteJavaScript";
                }
                return truthy(header(headers, "x-ms-documentdb-is-upsert")) ? "Upsert" : "Create";
            case "PUT":
                return "Replace";
            case "PATCH":
                return "Patch";
            case "DELETE":
                return "Delete";
            default:
                return verb;
        }
    }

    /**
     * Classifies a Cosmos DB operation type, compared case-insensitively and reported with the table's spelling. A request
     * that names a pre-trigger or post-trigger is a write whatever its operation, and so is a type the table doesn't know.
     *
     * @param triggers whether the request names a trigger
     */
    public static Classified cosmos(String operationType, boolean triggers, Set<String> treatAsRead) {
        StoreTables.Cosmos table = StoreTables.cosmos();
        String given = operationType == null ? "UNKNOWN" : operationType;
        String operation = table.canonical().getOrDefault(given.toLowerCase(Locale.ROOT), given);
        if (!triggers && table.read().contains(operation)) {
            return new Classified(CommandKind.READ, operation);
        }
        Classified write = new Classified(CommandKind.WRITE, operation);
        return triggers ? write : withHostReads(write, treatAsRead);
    }

    /** Classifies a request seen on the HTTP pipeline: the operation is derived from the method, path and headers. */
    public static Classified cosmosRequest(String method, String path, Map<String, ?> headers, Set<String> treatAsRead) {
        boolean triggers = header(headers, "x-ms-documentdb-pre-trigger-include") != null
                || header(headers, "x-ms-documentdb-post-trigger-include") != null;
        return cosmos(cosmosOperation(method, path, headers), triggers, treatAsRead);
    }

    // ---- Firestore ----

    /** Derives a Firestore RPC name from a REST request, as {@code fromRest} in the table lists. */
    public static String firestoreRpc(String method, String path) {
        List<String> parts = segments(path);
        String last = parts.isEmpty() ? "" : parts.get(parts.size() - 1);
        int colon = last.lastIndexOf(':');
        if (colon >= 0) {
            String verb = last.substring(colon + 1);
            return StoreTables.firestore().restVerbs().getOrDefault(verb, verb);
        }
        int documents = parts.indexOf("documents");
        int after = parts.size() - (documents + 1);
        boolean document = documents >= 0 && after > 0 && after % 2 == 0;
        String verb = method.toUpperCase(Locale.ROOT);
        return switch (verb) {
            case "GET" -> document ? "GetDocument" : "ListDocuments";
            case "PATCH" -> "UpdateDocument";
            case "DELETE" -> "DeleteDocument";
            case "POST" -> document ? "POST" : "CreateDocument";
            default -> verb;
        };
    }

    /**
     * Classifies a Firestore RPC, given as the gRPC path ({@code /google.firestore.v1.Firestore/Commit}) or a bare method
     * of the v1 service. A method of any other service is a write, except an admin method that starts with {@code Get} or
     * {@code List}. {@code Commit} is a write when it carries at least one write; with none it only ends a transaction
     * and is a session call. A hook that can't read the message passes {@code commitWrites = null}, and every
     * {@code Commit} is then a write.
     *
     * @param commitWrites the number of writes the {@code Commit} message carries, or {@code null} when unreadable
     */
    public static Classified firestore(String rpc, Integer commitWrites, Set<String> treatAsRead) {
        String service = "google.firestore.v1.Firestore";
        String name = rpc;
        if (rpc.contains("/")) {
            List<String> parts = new ArrayList<>();
            for (String part : rpc.split("/")) {
                if (!part.isEmpty()) {
                    parts.add(part);
                }
            }
            service = parts.isEmpty() ? "" : parts.get(0);
            name = parts.size() > 1 ? parts.get(1) : "";
        }
        StoreTables.FirestoreService known = StoreTables.firestore().services().get(service);
        if (known == null) {
            return withHostReads(new Classified(CommandKind.WRITE, name), treatAsRead);
        }
        if (!known.readPrefixes().isEmpty()) {
            String method = name;
            boolean reads = known.readPrefixes().stream().anyMatch(method::startsWith);
            return withHostReads(new Classified(reads ? CommandKind.READ : CommandKind.WRITE, name), treatAsRead);
        }
        if (name.equals("Commit")) {
            return new Classified(commitWrites != null && commitWrites == 0 ? CommandKind.SESSION : CommandKind.WRITE, name);
        }
        if (known.read().contains(name)) {
            return new Classified(CommandKind.READ, name);
        }
        if (known.session().contains(name)) {
            return new Classified(CommandKind.SESSION, name);
        }
        return withHostReads(new Classified(CommandKind.WRITE, name), treatAsRead);
    }

    /** Classifies a Firestore RPC given with its message as a JSON-like map, as the shared vectors give it. */
    public static Classified firestore(String rpc, Map<?, ?> message, Set<String> treatAsRead) {
        Integer writes = null;
        if (message != null) {
            Object list = message.get("writes");
            writes = list == null ? Integer.valueOf(0) : list instanceof java.util.Collection<?> items ? Integer.valueOf(items.size()) : null;
        }
        return firestore(rpc, writes, treatAsRead);
    }

    /** Classifies a request on Firestore's REST transport: the RPC is derived from the method and path. */
    public static Classified firestoreRest(String method, String path, Map<?, ?> body, Set<String> treatAsRead) {
        return firestore(firestoreRpc(method, path), body, treatAsRead);
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
