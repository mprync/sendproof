package io.github.mprync.sendproof.core;

/**
 * Identifies who may read an observed send's trace: one authenticated subject, within one authentication context and
 * mount. Two sessions of the same subject share an owner; different subjects never do.
 *
 * @param authenticationType the authentication scheme or token type
 * @param subject            the stable authenticated subject (for example a {@code sub} claim)
 * @param mount              the application mount (context path)
 */
public record TraceOwner(String authenticationType, String subject, String mount) {

    /** Maximum accepted length for each component. */
    public static final int MAX_LENGTH = 256;

    /**
     * Creates an owner, or returns {@code null} when any component is missing or oversized, which means the request
     * cannot be attributed to a stable subject.
     */
    public static TraceOwner of(String authenticationType, String subject, String mount) {
        if (authenticationType == null || authenticationType.length() > MAX_LENGTH || subject == null
                || subject.isEmpty() || subject.length() > MAX_LENGTH || mount == null || mount.length() > 4096) {
            return null;
        }
        return new TraceOwner(authenticationType, subject, mount);
    }
}
