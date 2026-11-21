package dev.testbench.core;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.Map;

/** The buffered inner response of a previewed handler, as a framework adapter captured it. */
public interface CapturedResponse {

    /** Returns the inner HTTP status. */
    int status();

    /** Returns the inner response headers, in order, with each name mapped to its values. */
    Map<String, java.util.List<String>> headers();

    /**
     * Returns the decoded body: parsed JSON for JSON content types, text for {@code text/*} or untyped bodies and a
     * Base64 string otherwise; {@code null} when the body is empty.
     */
    JsonNode body();

    /** Returns whether the handler tried to write more than {@link CaptureLimits#RESPONSE_BYTES}. */
    boolean exceededLimit();
}
