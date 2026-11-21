package dev.testbench.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.TextNode;
import java.io.IOException;
import java.nio.charset.Charset;
import java.util.Base64;
import java.util.Locale;

/** Decodes a buffered inner response body into the JSON value carried by a preview envelope. */
public final class CapturedBodies {
    private CapturedBodies() {
    }

    /**
     * Decodes a body: parsed JSON for {@code application/json} and {@code +json} types (falling back to text when it
     * does not parse), text for {@code text/*} or untyped bodies, and Base64 for anything else.
     *
     * @param contentType the response content type, or {@code null}
     * @param charset     the charset text is decoded with
     * @return the decoded value, or {@code null} when the body is empty
     */
    public static JsonNode decode(byte[] bytes, String contentType, Charset charset) {
        if (bytes.length == 0) {
            return null;
        }
        String mime = contentType == null ? "" : contentType.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        if (mime.equals("application/json") || mime.endsWith("+json")) {
            try {
                return Json.MAPPER.readTree(bytes);
            } catch (IOException error) {
                return new TextNode(new String(bytes, charset));
            }
        }
        if (mime.isEmpty() || mime.startsWith("text/")) {
            return new TextNode(new String(bytes, charset));
        }
        return new TextNode(Base64.getEncoder().encodeToString(bytes));
    }
}
