package io.github.mprync.sendproof.spring;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.web.ErrorResponse;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerExecutionChain;
import org.springframework.web.servlet.HandlerMapping;
import org.springframework.web.util.ServletRequestPathUtils;
import org.springframework.web.util.UrlPathHelper;

/**
 * Resolves the handler a rewritten preview request would reach, before anything in the filter chain runs. A preview
 * whose target is not a {@link SendproofPreview}-marked controller method is refused up front, so code that answers
 * from a servlet filter (Spring Security's logout, login or switch-user endpoints, or the host's own filters) never
 * runs for an unmarked target. Marked targets still go through the whole filter chain, including Spring Security.
 *
 * <p>The lookup uses the same handler mappings as the {@code DispatcherServlet}, in the same order, on a view of the
 * request whose attributes are private, so nothing it caches (parsed paths, URI variables) leaks into the real
 * dispatch.
 */
final class PreviewTargets {
    private final ObjectProvider<HandlerMapping> mappings;
    private final UnguardedClients unguarded;

    PreviewTargets(ObjectProvider<HandlerMapping> mappings, UnguardedClients unguarded) {
        this.mappings = mappings;
        this.unguarded = unguarded;
    }

    /**
     * Returns {@code 0} when the request maps to a marked controller method, otherwise the status to refuse it with:
     * 404 when nothing (or a non-controller handler) matches, 409 for an unmarked operation, or for any operation while the
     * application has a client bean Sendproof can't guard ({@link UnguardedClients}), or the mapping's own status (405
     * method not allowed, 415, 406, 400) when the match fails.
     */
    int check(HttpServletRequest request) {
        var isolated = new PrivateAttributes(request);
        for (HandlerMapping mapping : mappings.orderedStream().toList()) {
            HandlerExecutionChain chain;
            try {
                chain = mapping.getHandler(isolated);
            } catch (Exception error) {
                return error instanceof ErrorResponse response ? response.getStatusCode().value() : 409;
            }
            if (chain != null) {
                if (!(chain.getHandler() instanceof HandlerMethod method)) {
                    return 404;
                }
                return PreviewEligibility.isMarked(method) && (unguarded == null || unguarded.block() == null) ? 0 : 409;
            }
        }
        return 404;
    }

    /** A request view whose attribute writes stay local, and that hides path data cached for the original URL. */
    private static final class PrivateAttributes extends HttpServletRequestWrapper {
        private final Map<String, Object> local = new HashMap<>();
        private final Set<String> removed = new HashSet<>(Set.of(ServletRequestPathUtils.PATH_ATTRIBUTE,
                UrlPathHelper.PATH_ATTRIBUTE));

        PrivateAttributes(HttpServletRequest request) {
            super(request);
        }

        @Override
        public Object getAttribute(String name) {
            if (local.containsKey(name)) {
                return local.get(name);
            }
            return removed.contains(name) ? null : super.getAttribute(name);
        }

        @Override
        public Enumeration<String> getAttributeNames() {
            Set<String> names = new HashSet<>(Collections.list(super.getAttributeNames()));
            names.removeAll(removed);
            names.addAll(local.keySet());
            return Collections.enumeration(names);
        }

        @Override
        public void setAttribute(String name, Object value) {
            if (value == null) {
                removeAttribute(name);
                return;
            }
            removed.remove(name);
            local.put(name, value);
        }

        @Override
        public void removeAttribute(String name) {
            local.remove(name);
            removed.add(name);
        }
    }
}
