package io.github.mprync.sendproof.core;

import java.io.IOException;

/** Raised when a previewed handler writes more than {@link CaptureLimits#RESPONSE_BYTES} of response body. */
public final class PreviewResponseTooLargeException extends IOException {
    private static final long serialVersionUID = 1L;

    /** Creates the exception. */
    public PreviewResponseTooLargeException() {
        super("The preview response exceeds the 1 MiB limit.");
    }
}
