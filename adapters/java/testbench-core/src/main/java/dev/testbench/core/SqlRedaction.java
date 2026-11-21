package dev.testbench.core;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Decides which SQL values are hidden. Names are matched as whole words, so {@code idempotency_key} and
 * {@code monkey} stay visible while {@code password_hash}, {@code api_key} and {@code refreshToken} are hidden.
 */
public final class SqlRedaction {
    /** The replacement shown instead of a hidden value. */
    public static final String REDACTED = "[REDACTED]";

    private static final Set<String> SECRET_WORDS = Set.of("password", "passwd", "pwd", "secret", "token", "hash",
            "salt", "credential", "credentials", "apikey");
    // "key" alone is ordinary (primary key, idempotency key); it is secret only after one of these words.
    private static final Set<String> KEY_QUALIFIERS = Set.of("api", "private", "secret", "access", "signing",
            "encryption", "client");

    private SqlRedaction() {
    }

    /** Returns whether an identifier or a whole statement names a secret, judged by whole words. */
    public static boolean looksSecret(String text) {
        String previous = null;
        for (String word : words(text)) {
            String lower = word.toLowerCase(Locale.ROOT);
            if (SECRET_WORDS.contains(lower) || (lower.equals("key") && previous != null && KEY_QUALIFIERS.contains(previous))) {
                return true;
            }
            previous = lower;
        }
        return false;
    }

    /** Splits text at punctuation, underscores and camel-case boundaries. */
    static List<String> words(String text) {
        var words = new ArrayList<String>();
        int start = -1;
        for (int i = 0; i <= text.length(); i++) {
            boolean letterOrDigit = i < text.length() && Character.isLetterOrDigit(text.charAt(i));
            boolean boundary = !letterOrDigit
                    || (start >= 0 && Character.isUpperCase(text.charAt(i)) && Character.isLowerCase(text.charAt(i - 1)));
            if (boundary && start >= 0) {
                words.add(text.substring(start, i));
                start = -1;
            }
            if (letterOrDigit && start < 0) {
                start = i;
            }
        }
        return words;
    }
}
