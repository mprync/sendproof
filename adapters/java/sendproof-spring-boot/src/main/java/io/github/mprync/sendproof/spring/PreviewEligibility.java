package io.github.mprync.sendproof.spring;

import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.web.method.HandlerMethod;

/**
 * Decides whether a handler carries {@link SendproofPreview}, on the method or its controller class (the method wins), and
 * whether the mark enables Preview or publishes the operation as unavailable.
 */
final class PreviewEligibility {
    private PreviewEligibility() {
    }

    /** The mark that applies to a handler: its own, else its controller's, else {@code null}. */
    static SendproofPreview mark(HandlerMethod handler) {
        SendproofPreview method = AnnotatedElementUtils.findMergedAnnotation(handler.getMethod(), SendproofPreview.class);
        return method != null ? method : AnnotatedElementUtils.findMergedAnnotation(handler.getBeanType(), SendproofPreview.class);
    }

    /** Whether the handler is marked, and not as unavailable. */
    static boolean isMarked(HandlerMethod handler) {
        SendproofPreview mark = mark(handler);
        return mark != null && mark.enabled();
    }

    /** Whether the handler is marked {@code enabled = false}. */
    static boolean isUnavailable(HandlerMethod handler) {
        SendproofPreview mark = mark(handler);
        return mark != null && !mark.enabled();
    }

    static boolean allows(HandlerMethod handler, boolean sessionRead) {
        return sessionRead ? !isUnavailable(handler) : isMarked(handler);
    }
}
