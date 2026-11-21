package dev.testbench.spring;

import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.web.method.HandlerMethod;

/** Decides whether a handler carries {@link TestBenchPreview}, on the method or its controller class. */
final class PreviewEligibility {
    private PreviewEligibility() {
    }

    static boolean isMarked(HandlerMethod handler) {
        return AnnotatedElementUtils.hasAnnotation(handler.getMethod(), TestBenchPreview.class)
                || AnnotatedElementUtils.hasAnnotation(handler.getBeanType(), TestBenchPreview.class);
    }
}
