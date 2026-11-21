package io.github.mprync.sendproof.redis;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Builds the {@code Db} statement of a Redis command: the name, then each key argument as written and every other
 * argument as {@code ?} ({@code SET session:42 ?}). Values never appear. A command whose key positions aren't known
 * shows no keys.
 */
final class RedisStatements {
    /** Commands whose arguments are all keys. */
    private static final Set<String> ALL_KEYS = Set.of("DEL", "UNLINK", "EXISTS", "MGET", "TOUCH", "WATCH", "SINTER", "SUNION",
            "SDIFF", "SINTERSTORE", "SUNIONSTORE", "SDIFFSTORE", "PFCOUNT", "PFMERGE", "RENAME", "RENAMENX", "SMOVE",
            "RPOPLPUSH", "LMOVE", "BLMOVE", "COPY");
    /** Commands whose arguments alternate key and value. */
    private static final Set<String> KEY_VALUE_PAIRS = Set.of("MSET", "MSETNX");
    /** Commands that take a sub-command first and the key after it. */
    private static final Set<String> SUB_COMMAND_THEN_KEY = Set.of("OBJECT", "XINFO", "MEMORY", "XGROUP");
    /** Commands that take no key, or whose first argument is not one. */
    private static final Set<String> NO_KEY = Set.of("CONFIG", "CLIENT", "SCRIPT", "FUNCTION", "ACL", "CLUSTER", "MODULE",
            "DEBUG", "SLOWLOG", "LATENCY", "COMMAND", "PUBSUB", "KEYS", "SCAN", "SELECT", "FLUSHDB", "FLUSHALL", "INFO", "PING",
            "ECHO", "TIME", "DBSIZE", "SAVE", "BGSAVE", "BGREWRITEAOF", "SHUTDOWN", "SWAPDB", "FAILOVER", "REPLICAOF",
            "SLAVEOF", "WAIT", "MIGRATE", "LASTSAVE", "ROLE", "MONITOR", "SYNC", "PSYNC", "RESET", "QUIT", "AUTH", "HELLO",
            "MULTI", "EXEC", "DISCARD", "UNWATCH", "RANDOMKEY", "PUBLISH", "SPUBLISH", "SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE",
            "UNSUBSCRIBE", "PUNSUBSCRIBE", "SUNSUBSCRIBE", "LOLWUT", "SENTINEL", "WAITAOF");
    /** Commands that take a number of keys, then the keys: {@code EVAL script numkeys key... arg...}. */
    private static final Set<String> SCRIPTS = Set.of("EVAL", "EVALSHA", "EVAL_RO", "EVALSHA_RO", "FCALL", "FCALL_RO");

    private RedisStatements() {
    }

    /** A command rendered for the log. */
    record Described(String statement, String target) {
    }

    /** The text of one argument, for a key position. */
    static String text(Object argument) {
        return argument instanceof byte[] bytes ? new String(bytes, StandardCharsets.UTF_8) : String.valueOf(argument);
    }

    /** Renders {@code name} and its flattened arguments; only key positions keep their text. */
    static Described describe(String name, List<?> arguments) {
        String command = name.toUpperCase(Locale.ROOT);
        var shown = new java.util.BitSet(arguments.size());
        if (ALL_KEYS.contains(command)) {
            shown.set(0, arguments.size());
        } else if (KEY_VALUE_PAIRS.contains(command)) {
            for (int i = 0; i < arguments.size(); i += 2) {
                shown.set(i);
            }
        } else if (SUB_COMMAND_THEN_KEY.contains(command)) {
            if (arguments.size() > 1) {
                shown.set(1);
            }
        } else if (SCRIPTS.contains(command)) {
            int keys = arguments.size() > 1 ? parse(arguments.get(1)) : 0;
            for (int i = 0; i < keys && 2 + i < arguments.size(); i++) {
                shown.set(2 + i);
            }
        } else if (!NO_KEY.contains(command) && !arguments.isEmpty()) {
            shown.set(0);
        }
        var statement = new StringBuilder(command);
        String target = null;
        for (int i = 0; i < arguments.size(); i++) {
            statement.append(' ');
            if (shown.get(i)) {
                String key = text(arguments.get(i));
                statement.append(key);
                if (target == null) {
                    target = key;
                }
            } else {
                statement.append('?');
            }
        }
        return new Described(statement.toString(), target);
    }

    private static int parse(Object value) {
        try {
            return Math.max(0, Integer.parseInt(text(value)));
        } catch (NumberFormatException notANumber) {
            return 0;
        }
    }
}
