package dev.testbench.jpa;

import java.lang.reflect.Method;
import org.aopalliance.aop.Advice;
import org.aopalliance.intercept.MethodInterceptor;
import org.springframework.aop.Pointcut;
import org.springframework.aop.support.AbstractPointcutAdvisor;
import org.springframework.aop.support.StaticMethodMatcherPointcut;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.transaction.annotation.Transactional;

/**
 * Flushes the persistence context when a {@code @Transactional} method returns during a preview.
 *
 * <p>A participating {@code @Transactional} call does not commit, so Spring would never flush it, and a constraint
 * violation would only appear after the handler had already answered. Flushing at the method boundary makes the
 * violation surface where a real commit would raise it, so the host's own error handling responds to it. Outside a
 * preview the advice does nothing.
 */
final class PreviewFlushAdvisor extends AbstractPointcutAdvisor {
    private static final long serialVersionUID = 1L;

    private final transient Pointcut pointcut = new StaticMethodMatcherPointcut() {
        @Override
        public boolean matches(Method method, Class<?> targetClass) {
            return AnnotatedElementUtils.hasAnnotation(method, Transactional.class)
                    || AnnotatedElementUtils.hasAnnotation(targetClass, Transactional.class);
        }
    };

    private final transient Advice advice = (MethodInterceptor) invocation -> {
        Object result = invocation.proceed();
        PreviewTransactionGuard.flushIfActive();
        return result;
    };

    @Override
    public Pointcut getPointcut() {
        return pointcut;
    }

    @Override
    public Advice getAdvice() {
        return advice;
    }
}
