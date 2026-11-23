package io.github.mprync.sendproof.core;

import com.fasterxml.jackson.databind.node.ObjectNode;

/** Matchers for values which are generated or change during a step. */
public final class Match {
    private Match() {}

    /** Matches an existing value of the protocol type, for example {@code uuid}, {@code number} or {@code any}. */
    public static ObjectNode any(String type) {
        return Json.MAPPER.createObjectNode().put("type", type);
    }

    public static ObjectNode pattern(String regex) {
        return Json.MAPPER.createObjectNode().put("pattern", regex);
    }

    public static ObjectNode changed(Object from, Object to) {
        var change = Json.MAPPER.createObjectNode();
        change.set("from", Json.MAPPER.valueToTree(from));
        change.set("to", Json.MAPPER.valueToTree(to));
        return change;
    }
}
