package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.Json;
import io.github.mprync.sendproof.core.PreviewExecution;
import io.github.mprync.sendproof.core.PreviewOutcome;
import io.github.mprync.sendproof.core.Protocol;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Serves the reserved {@code /sendproof/_preview/**} route. It runs before Spring Security, rewrites the request to the
 * original operation, and sends it down the normal filter chain and {@code DispatcherServlet} in the same thread. The
 * response is buffered, the provider's transaction is rolled back, and only then is the envelope written.
 *
 * <p>Before dispatching it refuses cross-origin previews and targets that are not a marked controller method (see
 * {@link PreviewTargets}), so nothing in the filter chain runs for them.
 *
 * <p>It also marks ordinary requests that carry {@code Prefer: trace} so the handler interceptor can observe them, and
 * refuses {@code Prefer: tx=rollback} on any other URL so a rollback request can never silently commit.
 */
final class SendproofFilter extends OncePerRequestFilter {
    private final PreviewTargets targets;

    SendproofFilter(PreviewTargets targets) {
        this.targets = targets;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        long started = System.nanoTime();
        String path = request.getRequestURI().substring(request.getContextPath().length());
        int prefix = previewPrefix(request, path);
        if (prefix < 0) {
            if (!request.getMethod().equals("HEAD") && Protocol.observedRequested(values(request, "Prefer"))
                    && isSameOrigin(request)) {
                request.setAttribute(ObservedState.ATTRIBUTE, new ObservedState(started));
            }
            if (Protocol.requestsRollback(values(request, "Prefer"))) {
                reject(response, 400, "Use the Sendproof preview URL for rollback requests.", null);
                return;
            }
            // Every ordinary request is marked, so a data store write that belongs to no request (a background thread) can be
            // told apart from a Send while a Preview is open.
            CaptureContext.Scope attributed = CaptureContext.enterAttributed();
            try {
                chain.doFilter(request, response);
            } finally {
                attributed.close();
            }
            return;
        }

        if (!Protocol.hasExactPreference(values(request, "Prefer"))) {
            reject(response, 400, "A Sendproof preview requires Prefer: tx=rollback.", null);
        } else if (request.getMethod().equals("HEAD")) {
            reject(response, 405, "A preview requires a response body.", null);
        } else {
            String target = path.substring(prefix + Protocol.PREVIEW_PREFIX.length());
            if (!Protocol.isValidTarget(target)) {
                reject(response, 400, "The Sendproof preview target is invalid.", null);
            } else if (!isSameOrigin(request)) {
                // Refused before anything runs, so a cross-site page cannot drive filters or handlers through a preview.
                reject(response, 403, "Cross-origin previews are refused.", null);
            } else {
                var rewritten = new PreviewRequestWrapper(request, path.substring(0, prefix) + target);
                int refusal = targets.check(rewritten);
                if (refusal != 0) {
                    reject(response, refusal, refusal == 409 ? "This operation is unavailable for preview."
                            : "The preview target was not found for this method.", null);
                } else {
                    preview(request, response, chain, started, rewritten);
                }
            }
        }
    }

    /**
     * Finds the reserved prefix at the application mount, or directly after the {@code DispatcherServlet}'s own prefix
     * when it is mapped to a path such as {@code /api/*}. A {@code /sendproof/_preview} segment deeper in a path is an
     * ordinary URL.
     */
    private static int previewPrefix(HttpServletRequest request, String path) {
        int prefix = Protocol.previewPrefixIndex(path);
        if (prefix <= 0) {
            return prefix;
        }
        String servletPath = request.getServletPath();
        String mapped = path.substring(0, prefix);
        return request.getPathInfo() != null && !servletPath.isEmpty() && mapped.equals(servletPath) ? prefix : -1;
    }

    private void preview(HttpServletRequest request, HttpServletResponse response, FilterChain chain, long started,
                         PreviewRequestWrapper rewritten) throws IOException {
        var execution = new PreviewExecution(started);
        request.setAttribute(PreviewState.ATTRIBUTE, new PreviewState(execution));
        var inner = new PreviewResponseWrapper(response);
        Throwable failure = null;
        PreviewOutcome outcome;
        CaptureContext.Scope scope = CaptureContext.enter(execution.capture());
        try {
            try {
                chain.doFilter(rewritten, inner);
            } catch (Throwable error) {
                failure = error;
            }
            outcome = execution.finish(inner, failure);
        } finally {
            scope.close();
            request.removeAttribute(PreviewState.ATTRIBUTE);
        }
        write(response, outcome);
    }

    private static void write(HttpServletResponse response, PreviewOutcome outcome) throws IOException {
        if (response.isCommitted()) {
            return;
        }
        // Drops anything the container attached on its own, such as a new session cookie.
        response.reset();
        if (outcome.blocked()) {
            // A guarded store refused a write: 409 problem+json, never a confirmation and without the handler's output.
            response.setStatus(outcome.status());
            response.setHeader("Cache-Control", "no-store");
            response.setContentType("application/problem+json;charset=UTF-8");
            response.setContentLength(outcome.problem().length);
            response.getOutputStream().write(outcome.problem());
            return;
        }
        if (!outcome.confirmed()) {
            reject(response, outcome.status(), outcome.title(), outcome.challenge());
            return;
        }
        response.setStatus(200);
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Preference-Applied", Protocol.ROLLBACK_PREFERENCE);
        response.setHeader("Server-Timing", outcome.serverTiming());
        response.setContentType("application/json;charset=UTF-8");
        response.setContentLength(outcome.json().length);
        response.getOutputStream().write(outcome.json());
    }

    private static void reject(HttpServletResponse response, int status, String title, String challenge)
            throws IOException {
        if (response.isCommitted()) {
            return;
        }
        response.reset();
        response.setStatus(status);
        response.setHeader("Cache-Control", "no-store");
        if (challenge != null) {
            response.setHeader("WWW-Authenticate", challenge);
        }
        Map<String, Object> problem = new LinkedHashMap<>();
        problem.put("type", "about:blank");
        problem.put("title", title);
        problem.put("status", status);
        byte[] bytes = Json.MAPPER.writeValueAsBytes(problem);
        response.setContentType("application/problem+json;charset=UTF-8");
        response.setContentLength(bytes.length);
        response.getOutputStream().write(bytes);
    }

    static java.util.List<String> values(HttpServletRequest request, String name) {
        return Collections.list(request.getHeaders(name));
    }

    static boolean isSameOrigin(HttpServletRequest request) {
        return Protocol.isSameOrigin(request.getHeader("Sec-Fetch-Site"), values(request, "Origin"),
                request.getScheme(), request.getHeader("Host"));
    }
}
