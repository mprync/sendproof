package io.github.mprync.sendproof.core.stores;

import java.util.Locale;

/**
 * What the guard needs to know about one statement of CQL or SQL text: its first two words, and whether the text is a
 * single well-formed statement. It reads the text the way the server would, so a second statement hidden after a
 * semicolon, or inside a comment or string the guard mis-parsed, can't turn a write into a read.
 *
 * @param first    the first word in upper case, after whitespace and comments; empty when there is none
 * @param second   the word after it in upper case (CQL's {@code LIST ROLES}), or empty
 * @param multiple whether anything but whitespace and comments follows the first semicolon outside quotes
 * @param broken   whether a quote or block comment never ends
 */
public record StatementShape(String first, String second, boolean multiple, boolean broken) {
    private static final StatementShape BROKEN = new StatementShape("", "", false, true);

    /**
     * Reads {@code text}. Quotes are {@code '…'} and {@code "…"} with doubled-quote escapes; {@code backticks} adds
     * {@code `…`}, {@code dollar} adds CQL's {@code $$…$$} strings and {@code slashComments} adds {@code //} line comments.
     */
    public static StatementShape of(String text, boolean backticks, boolean dollar, boolean slashComments) {
        String source = text == null ? "" : text;
        int[] at = {0};
        try {
            String first = word(source, at, slashComments);
            String second = word(source, at, slashComments);
            boolean multiple = false;
            while (at[0] < source.length()) {
                if (comment(source, at, slashComments)) {
                    continue;
                }
                char c = source.charAt(at[0]);
                String quote = c == '\'' || c == '"' || (backticks && c == '`') ? String.valueOf(c)
                        : dollar && source.startsWith("$$", at[0]) ? "$$" : null;
                if (quote != null) {
                    int end = at[0] + quote.length();
                    while (true) {
                        end = source.indexOf(quote, end);
                        if (end < 0) {
                            return BROKEN;
                        }
                        if (!quote.equals("$$") && end + 1 < source.length() && source.charAt(end + 1) == quote.charAt(0)) {
                            end += 2;
                            continue;
                        }
                        break;
                    }
                    at[0] = end + quote.length();
                    continue;
                }
                at[0]++;
                if (c == ';') {
                    skip(source, at, slashComments);
                    multiple = at[0] < source.length();
                    break;
                }
            }
            return new StatementShape(first, second, multiple, false);
        } catch (IllegalStateException unterminated) {
            return BROKEN;
        }
    }

    private static boolean comment(String source, int[] at, boolean slashComments) {
        int index = at[0];
        if (source.startsWith("--", index) || (slashComments && source.startsWith("//", index))) {
            int end = source.indexOf('\n', index);
            at[0] = end < 0 ? source.length() : end + 1;
            return true;
        }
        if (source.startsWith("/*", index)) {
            int end = source.indexOf("*/", index + 2);
            if (end < 0) {
                throw new IllegalStateException("unterminated comment");
            }
            at[0] = end + 2;
            return true;
        }
        return false;
    }

    private static void skip(String source, int[] at, boolean slashComments) {
        while (true) {
            while (at[0] < source.length() && Character.isWhitespace(source.charAt(at[0]))) {
                at[0]++;
            }
            if (!comment(source, at, slashComments)) {
                return;
            }
        }
    }

    private static String word(String source, int[] at, boolean slashComments) {
        skip(source, at, slashComments);
        int end = at[0];
        while (end < source.length() && (isAsciiLetter(source.charAt(end)) || source.charAt(end) == '_')) {
            end++;
        }
        String word = source.substring(at[0], end).toUpperCase(Locale.ROOT);
        at[0] = end;
        return word;
    }

    private static boolean isAsciiLetter(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    }
}
