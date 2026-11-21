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
 *
 * <p>An operation that writes a data store that can't roll back (Redis, DynamoDB, MongoDB on a standalone server) can be
 * marked {@code enabled = false}. It is then not advertised as previewable, the workbench shows "Preview unavailable"
 * with the reason before anyone tries, and a Preview of it never runs the handler. Sendproof never infers this mark:
 * without it the operation is advertised and the write guard decides at run time, which is also safe.
 *
 * <pre>{@code
 * @SendproofPreview(enabled = false, reason = "Clears the Redis session")
 * @DeleteMapping("/sessions/{id}") void deleteSession(@PathVariable String id) { ... }
 * }</pre>
 *
 * A method-level mark overrides the class-level one, so one handler can opt out of an annotated controller.
 */
@Target({ElementType.METHOD, ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
@Documented
public @interface SendproofPreview {

    /** Whether the operation can be previewed. {@code false} publishes it as unavailable, with {@link #reason()}. */
    boolean enabled() default true;

    /**
     * The sentence the workbench shows for an unavailable operation. Required unless {@link #stores()} names a store, in
     * which case it defaults to "Preview unavailable: this operation writes to &lt;Store&gt;".
     */
    String reason() default "";

    /** The stores an unavailable operation writes, as store ids such as {@code redis}, {@code dynamodb} or {@code mongodb}. */
    String[] stores() default {};
}
