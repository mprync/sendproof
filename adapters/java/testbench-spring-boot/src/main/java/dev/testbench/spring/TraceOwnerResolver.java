package dev.testbench.spring;

import dev.testbench.core.TraceOwner;
import jakarta.servlet.http.HttpServletRequest;
import java.security.Principal;

/**
 * Attributes a request to the one authenticated subject that may read its observed-send trace. An anonymous request
 * has no owner and is never traced. Register a bean to supply a stronger notion of "stable subject".
 */
@FunctionalInterface
public interface TraceOwnerResolver {

    /** Returns the owner, or {@code null} when the request has no stable authenticated subject. */
    TraceOwner resolve(HttpServletRequest request);

    /** The default: the servlet {@link Principal}'s name within the request's authentication type and mount. */
    static TraceOwnerResolver principal() {
        return request -> {
            Principal principal = request.getUserPrincipal();
            if (principal == null) {
                return null;
            }
            String type = request.getAuthType() != null ? request.getAuthType() : principal.getClass().getSimpleName();
            return TraceOwner.of(type, principal.getName(), request.getContextPath());
        };
    }
}
