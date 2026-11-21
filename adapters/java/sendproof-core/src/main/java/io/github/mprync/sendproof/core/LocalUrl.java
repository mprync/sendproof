package io.github.mprync.sendproof.core;

/** Validation for application-relative, same-origin URLs advertised in discovery. */
public final class LocalUrl {
    private LocalUrl() {
    }

    /** Returns {@code url} when it is a local absolute path; otherwise throws. */
    public static String validate(String url) {
        if (url == null || url.isBlank()) {
            throw new IllegalArgumentException("A URL is required.");
        }
        if (!isLocal(url)) {
            throw new IllegalArgumentException("Use an application-relative, same-origin path: " + url);
        }
        return url;
    }

    /** Returns whether {@code url} is an absolute path on this origin with no traversal, backslashes or controls. */
    public static boolean isLocal(String url) {
        int query = url.indexOf('?');
        String path = query < 0 ? url : url.substring(0, query);
        String decoded = Protocol.percentDecode(path);
        if (decoded == null || !path.startsWith("/") || decoded.startsWith("//") || url.indexOf('#') >= 0
                || url.indexOf('\\') >= 0 || decoded.indexOf('\\') >= 0) {
            return false;
        }
        for (String segment : decoded.split("/", -1)) {
            if (segment.equals(".") || segment.equals("..")) {
                return false;
            }
        }
        for (int i = 0; i < url.length(); i++) {
            if (Character.isWhitespace(url.charAt(i)) || Character.isISOControl(url.charAt(i))) {
                return false;
            }
        }
        for (int i = 0; i < decoded.length(); i++) {
            if (Character.isISOControl(decoded.charAt(i))) {
                return false;
            }
        }
        return true;
    }
}
