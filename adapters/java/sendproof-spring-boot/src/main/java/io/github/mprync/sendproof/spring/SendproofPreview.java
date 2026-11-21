package io.github.mprync.sendproof.spring;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks a Spring MVC handler method (or every handler in a controller) as safe to preview and observe.
 *
 * <p>An eligible operation must enlist all of its writes in the transaction the {@code PreviewProvider} begins, and
 * must hold back external effects through {@code SendproofCapture}. Authorization, validation and parameter binding
 * always run against the host application. Handlers that start their own transaction ({@code REQUIRES_NEW}), write
 * outside Spring-managed transactions, or complete asynchronously are not eligible. Apply the annotation to a
 * controller class only when every handler in it qualifies.
 */
@Target({ElementType.METHOD, ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
@Documented
public @interface SendproofPreview {
}
