package io.github.mprync.sendproof.spring;

import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.web.method.HandlerMethod;

/** Decides whether a handler carries {@link SendproofPreview}, on the method or its controller class. */
final class PreviewEligibility {
    private PreviewEligibility() {
    }

    static boolean isMarked(HandlerMethod handler) {
        return AnnotatedElementUtils.hasAnnotation(handler.getMethod(), SendproofPreview.class)
                || AnnotatedElementUtils.hasAnnotation(handler.getBeanType(), SendproofPreview.class);
    }
}
