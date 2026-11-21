package io.github.mprync.sendproof.core;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.List;
import java.util.Locale;

/** Pure helpers for the Bench protocol v1 rules that every framework adapter shares. */
public final class Protocol {
    /** The reserved preview route, relative to the application mount. */
    public static final String PREVIEW_PREFIX = "/sendproof/_preview";
    /** The one accepted preview preference. */
    public static final String ROLLBACK_PREFERENCE = "tx=rollback";
    /** The header that carries an observed send's trace ID. */
    public static final String TRACE_HEADER = "X-Sendproof-Trace";

    private Protocol() {
    }

    /** Returns whether any {@code Prefer} value asks for {@code tx=rollback}, in any spelling. */
    public static boolean requestsRollback(List<String> preferValues) {
        for (String value : preferValues) {
            for (String part : value.split("[,;]")) {
                int equals = part.indexOf('=');
                if (equals > 0 && part.substring(0, equals).trim().equalsIgnoreCase("tx")
                        && trimQuotes(part.substring(equals + 1).trim()).equalsIgnoreCase("rollback")) {
                    return true;
                }
            }
        }
        return false;
    }

    /** Returns whether the request carries exactly one {@code Prefer: tx=rollback} and nothing else. */
    public static boolean hasExactPreference(List<String> preferValues) {
        return preferValues.size() == 1 && preferValues.get(0).trim().equalsIgnoreCase(ROLLBACK_PREFERENCE);
    }

    /** Returns whether a {@code Prefer} header asks for an observed send ({@code trace}). */
    public static boolean observedRequested(List<String> preferValues) {
        for (String value : preferValues) {
            for (String part : value.split(",")) {
                if (part.split(";", 2)[0].trim().equalsIgnoreCase("trace")) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Returns whether the request originates from the application's own origin. Browsers mark cross-site requests with
     * {@code Sec-Fetch-Site}; a present {@code Origin} must match the request's scheme, host and port exactly.
     *
     * @param secFetchSite the {@code Sec-Fetch-Site} header, or {@code null}
     * @param origins      every {@code Origin} header value
     * @param scheme       the request scheme
     * @param host         the {@code Host} header value, with optional port
     */
    public static boolean isSameOrigin(String secFetchSite, List<String> origins, String scheme, String host) {
        if ("cross-site".equalsIgnoreCase(secFetchSite)) {
            return false;
        }
        if (origins.isEmpty()) {
            return true;
        }
        if (origins.size() != 1 || host == null) {
            return false;
        }
        try {
            URI origin = new URI(origins.get(0));
            URI expected = new URI(scheme + "://" + host);
            return origin.getScheme() != null && origin.getHost() != null && expected.getHost() != null
                    && origin.getScheme().equalsIgnoreCase(expected.getScheme())
                    && origin.getHost().equalsIgnoreCase(expected.getHost())
                    && port(origin) == port(expected)
                    && origin.getRawUserInfo() == null
                    && (origin.getRawPath() == null || origin.getRawPath().isEmpty() || origin.getRawPath().equals("/"))
                    && origin.getRawQuery() == null && origin.getRawFragment() == null;
        } catch (URISyntaxException error) {
            return false;
        }
    }

    private static int port(URI uri) {
        if (uri.getPort() >= 0) {
            return uri.getPort();
        }
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    /**
     * Finds the reserved preview prefix in a mount-relative request path.
     *
     * @return the index of the prefix, or {@code -1} when the path is not a preview path
     */
    public static int previewPrefixIndex(String path) {
        int index = path.toLowerCase(Locale.ROOT).indexOf(PREVIEW_PREFIX);
        if (index < 0) {
            return -1;
        }
        int end = index + PREVIEW_PREFIX.length();
        return end == path.length() || path.charAt(end) == '/' ? index : -1;
    }

    /**
     * Validates the operation path that follows the preview prefix. It must be a local absolute path that cannot
     * climb out of the application or reach the workbench itself.
     */
    public static boolean isValidTarget(String target) {
        if (target.isEmpty() || target.charAt(0) != '/' || target.startsWith("//") || target.indexOf(';') >= 0 || target.indexOf('\\') >= 0) {
            return false;
        }
        String decoded = percentDecode(target);
        if (decoded == null || decoded.startsWith("//") || decoded.indexOf('\\') >= 0 || decoded.indexOf(';') >= 0) {
            return false;
        }
        for (int i = 0; i < decoded.length(); i++) {
            if (Character.isISOControl(decoded.charAt(i))) {
                return false;
            }
        }
        for (String segment : decoded.split("/", -1)) {
            if (segment.equals(".") || segment.equals("..")) {
                return false;
            }
        }
        String lower = decoded.toLowerCase(Locale.ROOT);
        return !(lower.equals("/sendproof") || lower.startsWith("/sendproof/"));
    }

    /** Percent-decodes UTF-8, returning {@code null} for malformed input. */
    static String percentDecode(String value) {
        var bytes = new java.io.ByteArrayOutputStream(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '%') {
                if (i + 2 >= value.length()) {
                    return null;
                }
                int high = Character.digit(value.charAt(i + 1), 16);
                int low = Character.digit(value.charAt(i + 2), 16);
                if (high < 0 || low < 0) {
                    return null;
                }
                bytes.write(high * 16 + low);
                i += 2;
            } else {
                byte[] encoded = String.valueOf(c).getBytes(java.nio.charset.StandardCharsets.UTF_8);
                bytes.write(encoded, 0, encoded.length);
            }
        }
        try {
            return java.nio.charset.StandardCharsets.UTF_8.newDecoder()
                    .decode(java.nio.ByteBuffer.wrap(bytes.toByteArray())).toString();
        } catch (java.nio.charset.CharacterCodingException error) {
            return null;
        }
    }

    private static String trimQuotes(String value) {
        return value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")
                ? value.substring(1, value.length() - 1) : value;
    }
}
