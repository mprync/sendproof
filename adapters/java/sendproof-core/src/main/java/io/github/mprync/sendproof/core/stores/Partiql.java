package io.github.mprync.sendproof.core.stores;

import java.util.Locale;

/** Helpers for the PartiQL text DynamoDB's {@code ExecuteStatement} family carries. */
public final class Partiql {
    private Partiql() {
    }

    /**
     * Skips whitespace, {@code --} line comments and {@code /* *}{@code /} block comments, then returns the first
     * word of a PartiQL statement in upper case; empty when there is none or a comment never ends.
     */
    public static String verb(String statement) {
        String text = statement == null ? "" : statement;
        int index = 0;
        while (true) {
            while (index < text.length() && Character.isWhitespace(text.charAt(index))) {
                index++;
            }
            if (text.startsWith("--", index)) {
                int end = text.indexOf('\n', index);
                if (end < 0) {
                    return "";
                }
                index = end + 1;
            } else if (text.startsWith("/*", index)) {
                int end = text.indexOf("*/", index + 2);
                if (end < 0) {
                    return "";
                }
                index = end + 2;
            } else {
                int end = index;
                while (end < text.length() && isAsciiLetter(text.charAt(end))) {
                    end++;
                }
                return text.substring(index, end).toUpperCase(Locale.ROOT);
            }
        }
    }

    /**
     * Replaces every literal in PartiQL text with {@code ?}: single-quoted strings (with {@code ''} escapes) and
     * numbers. Double-quoted identifiers (table and attribute names) are kept as written. A statement may inline
     * values instead of using {@code ?} parameters, and a value never appears in a {@code Db} entry.
     */
    public static String sanitize(String text) {
        return sanitize(text, false);
    }

    /**
     * Like {@link #sanitize(String)}; with {@code dollarStrings} a CQL {@code $$ … $$} string is replaced by {@code ?}
     * too, so {@code Cassandra} statements use the same routine.
     */
    public static String sanitize(String text, boolean dollarStrings) {
        var out = new StringBuilder(text.length());
        int index = 0;
        while (index < text.length()) {
            char c = text.charAt(index);
            if (dollarStrings && text.startsWith("$$", index)) {
                int end = text.indexOf("$$", index + 2);
                out.append('?');
                index = end < 0 ? text.length() : end + 2;
            } else if (c == '"') {
                int end = text.indexOf('"', index + 1);
                int stop = end < 0 ? text.length() : end + 1;
                out.append(text, index, stop);
                index = stop;
            } else if (c == '\'') {
                int end = index + 1;
                while (end < text.length() && !(text.charAt(end) == '\'' && (end + 1 >= text.length() || text.charAt(end + 1) != '\''))) {
                    end += text.charAt(end) == '\'' ? 2 : 1;
                }
                out.append('?');
                index = end + 1;
            } else if (c >= '0' && c <= '9' && !(index > 0 && (Character.isLetterOrDigit(text.charAt(index - 1))
                    || text.charAt(index - 1) == '_' || text.charAt(index - 1) == '.'))) {
                int end = index;
                while (end < text.length() && Character.isDigit(text.charAt(end))) {
                    end++;
                }
                if (end + 1 < text.length() && text.charAt(end) == '.' && Character.isDigit(text.charAt(end + 1))) {
                    end++;
                    while (end < text.length() && Character.isDigit(text.charAt(end))) {
                        end++;
                    }
                }
                if (end < text.length() && (text.charAt(end) == 'e' || text.charAt(end) == 'E')) {
                    int exponent = end + 1;
                    if (exponent < text.length() && (text.charAt(exponent) == '+' || text.charAt(exponent) == '-')) {
                        exponent++;
                    }
                    if (exponent < text.length() && Character.isDigit(text.charAt(exponent))) {
                        while (exponent < text.length() && Character.isDigit(text.charAt(exponent))) {
                            exponent++;
                        }
                        end = exponent;
                    }
                }
                out.append('?');
                index = end;
            } else {
                out.append(c);
                index++;
            }
        }
        return out.toString();
    }

    private static boolean isAsciiLetter(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    }
}
