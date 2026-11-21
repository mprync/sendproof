package io.github.mprync.sendproof.mongodb;

import java.lang.reflect.Method;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.bson.BsonArray;
import org.bson.BsonDocument;
import org.bson.BsonInt32;
import org.bson.BsonString;
import org.bson.codecs.configuration.CodecRegistry;
import org.bson.conversions.Bson;

/**
 * What each driver method sends, as the command document the guard classifies. The first key of the document is the
 * command name. A method this table doesn't know is refused during a Preview, so a driver method added later fails
 * closed.
 */
final class MongoCommands {
    /** How to turn a call into the command it sends. */
    @FunctionalInterface
    interface Rule {
        BsonDocument command(String name, Object[] arguments, CodecRegistry registry);
    }

    private static Rule simple(String command) {
        return (name, arguments, registry) -> new BsonDocument(command, new BsonString(name));
    }

    private static Rule database(String command) {
        return (name, arguments, registry) -> new BsonDocument(command, new BsonInt32(1));
    }

    private static Rule aggregate(boolean collection) {
        return (name, arguments, registry) -> new BsonDocument("aggregate",
                collection ? new BsonString(name) : new BsonInt32(1)).append("pipeline", pipeline(arguments, registry));
    }

    private static Rule changeStream(boolean collection) {
        return (name, arguments, registry) -> {
            var stages = new BsonArray();
            stages.add(new BsonDocument("$changeStream", new BsonDocument()));
            stages.addAll(pipeline(arguments, registry));
            return new BsonDocument("aggregate", collection ? new BsonString(name) : new BsonInt32(1)).append("pipeline", stages);
        };
    }

    /** The first list argument, as an array of documents; empty when there is none. */
    private static BsonArray pipeline(Object[] arguments, CodecRegistry registry) {
        var stages = new BsonArray();
        for (Object argument : arguments == null ? new Object[0] : arguments) {
            if (argument instanceof List<?> list) {
                for (Object stage : list) {
                    stages.add(document(stage, registry));
                }
                break;
            }
        }
        return stages;
    }

    /** The first Bson argument as a document: the command {@code runCommand} sends. */
    private static final Rule RUN_COMMAND = (name, arguments, registry) -> {
        for (Object argument : arguments == null ? new Object[0] : arguments) {
            if (argument instanceof Bson bson) {
                return document(bson, registry);
            }
        }
        return new BsonDocument();
    };

    private static final Rule CREATE_COLLECTION = (name, arguments, registry) -> {
        for (Object argument : arguments == null ? new Object[0] : arguments) {
            if (argument instanceof String collection) {
                return new BsonDocument("create", new BsonString(collection));
            }
        }
        return new BsonDocument("create", new BsonInt32(1));
    };

    private static BsonDocument document(Object value, CodecRegistry registry) {
        if (value instanceof BsonDocument bson) {
            return bson;
        }
        if (value instanceof Bson bson) {
            return bson.toBsonDocument(BsonDocument.class, registry);
        }
        throw new IllegalArgumentException("A MongoDB command or pipeline stage must be a Bson document.");
    }

    /** Converts a {@code runCommand}-style argument to a document with the default registry. */
    static BsonDocument toDocument(Object value, CodecRegistry registry) {
        return document(value, registry);
    }

    private static final Map<String, Rule> COLLECTION = Map.ofEntries(
            Map.entry("insertOne", simple("insert")), Map.entry("insertMany", simple("insert")),
            Map.entry("bulkWrite", simple("bulkWrite")),
            Map.entry("updateOne", simple("update")), Map.entry("updateMany", simple("update")),
            Map.entry("replaceOne", simple("update")),
            Map.entry("deleteOne", simple("delete")), Map.entry("deleteMany", simple("delete")),
            Map.entry("find", simple("find")), Map.entry("distinct", simple("distinct")),
            Map.entry("countDocuments", (name, arguments, registry) -> new BsonDocument("aggregate", new BsonString(name))
                    .append("pipeline", new BsonArray())),
            Map.entry("estimatedDocumentCount", simple("count")),
            Map.entry("findOneAndDelete", simple("findAndModify")), Map.entry("findOneAndReplace", simple("findAndModify")),
            Map.entry("findOneAndUpdate", simple("findAndModify")),
            Map.entry("aggregate", aggregate(true)), Map.entry("watch", changeStream(true)),
            Map.entry("mapReduce", simple("mapReduce")),
            Map.entry("renameCollection", simple("renameCollection")), Map.entry("drop", simple("drop")),
            Map.entry("createIndex", simple("createIndexes")), Map.entry("createIndexes", simple("createIndexes")),
            Map.entry("dropIndex", simple("dropIndexes")), Map.entry("dropIndexes", simple("dropIndexes")),
            Map.entry("createSearchIndex", simple("createSearchIndexes")), Map.entry("createSearchIndexes", simple("createSearchIndexes")),
            Map.entry("updateSearchIndex", simple("updateSearchIndex")), Map.entry("dropSearchIndex", simple("dropSearchIndex")),
            Map.entry("listIndexes", simple("listIndexes")), Map.entry("listSearchIndexes", simple("aggregate")));

    private static final Map<String, Rule> DATABASE = Map.ofEntries(
            Map.entry("runCommand", RUN_COMMAND),
            Map.entry("createCollection", CREATE_COLLECTION), Map.entry("createView", CREATE_COLLECTION),
            Map.entry("drop", database("dropDatabase")),
            Map.entry("listCollections", database("listCollections")), Map.entry("listCollectionNames", database("listCollections")),
            Map.entry("aggregate", aggregate(false)), Map.entry("watch", changeStream(false)));

    private static final Map<String, Rule> CLIENT = Map.ofEntries(
            Map.entry("listDatabases", database("listDatabases")), Map.entry("listDatabaseNames", database("listDatabases")),
            Map.entry("bulkWrite", database("bulkWrite")), Map.entry("watch", changeStream(false)));

    /** Methods that are neither commands nor handles, passed through untouched. */
    private static final Set<String> INERT = Set.of("getNamespace", "getDocumentClass", "getCodecRegistry", "getReadPreference",
            "getWriteConcern", "getReadConcern", "getTimeout", "getName", "getClusterDescription", "close", "hashCode",
            "equals", "toString", "timeout");

    private MongoCommands() {
    }

    /** The rule for a collection method, or {@code null}. */
    static Rule collection(String method) {
        return COLLECTION.get(method);
    }

    /** The rule for a database method, or {@code null}. */
    static Rule database(Method method) {
        return DATABASE.get(method.getName());
    }

    /** The rule for a client method, or {@code null}. */
    static Rule client(Method method) {
        return CLIENT.get(method.getName());
    }

    /** Whether a method is a getter or lifecycle call with no command behind it. */
    static boolean inert(String method) {
        return INERT.contains(method);
    }
}
