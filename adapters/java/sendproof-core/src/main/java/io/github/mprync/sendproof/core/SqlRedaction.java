package io.github.mprync.sendproof.core;

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

    /**
     * Returns whether an identifier or a whole statement names a secret, judged by whole words. Plurals count
     * ({@code api_tokens}, {@code passwords}), and so does a session identifier ({@code session_id},
     * {@code sessionId}, Spring Session's {@code SESSION_PRIMARY_ID}), whose value would let a reader take over a
     * signed-in session.
     */
    public static boolean looksSecret(String text) {
        String previous = null;
        String beforePrevious = null;
        for (String word : words(text)) {
            String lower = singular(word.toLowerCase(Locale.ROOT));
            if (SECRET_WORDS.contains(lower)
                    || (lower.equals("key") && previous != null && KEY_QUALIFIERS.contains(previous))
                    || (lower.equals("id") && ("session".equals(previous)
                        || ("primary".equals(previous) && "session".equals(beforePrevious))))) {
                return true;
            }
            beforePrevious = previous;
            previous = lower;
        }
        return false;
    }

    /** Reduces a plural to its singular for the secret words: tokens, hashes, keys, sessions. */
    private static String singular(String word) {
        if (word.length() > 4 && word.endsWith("es") && SECRET_WORDS.contains(word.substring(0, word.length() - 2))) {
            return word.substring(0, word.length() - 2);
        }
        if (word.length() > 3 && word.endsWith("s") && !word.endsWith("ss")) {
            String stem = word.substring(0, word.length() - 1);
            if (SECRET_WORDS.contains(stem) || stem.equals("key") || stem.equals("session")) {
                return stem;
            }
        }
        return word;
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
