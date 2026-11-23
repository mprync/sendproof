package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.ObservedExecution;
import io.github.mprync.sendproof.core.PreviewObservation;
import io.github.mprync.sendproof.core.PreviewProvider;
import io.github.mprync.sendproof.core.PreviewSessions;
import io.github.mprync.sendproof.core.Protocol;
import io.github.mprync.sendproof.core.TraceOwner;
import io.github.mprync.sendproof.core.TraceStore;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.ModelAndView;

/**
 * Runs once the host's routing and security have chosen a handler. For a preview it checks that the handler opted in
 * and starts the provider's rollback-only session immediately before the handler; for an observed send it reserves a
 * trace and starts capturing. Everything else passes through untouched.
 */
final class SendproofInterceptor implements HandlerInterceptor {
    private static final Logger LOG = LoggerFactory.getLogger(SendproofInterceptor.class);

    private final PreviewProviders providers;
    private final SendproofStores stores;
    private final WorkbenchAccess access;
    private final TraceOwnerResolver owners;
    private final WorkbenchIdentityResolver identities;
    private final TraceStore traces;
    private final PreviewSessions sessions;

    SendproofInterceptor(PreviewProviders providers, SendproofStores stores, WorkbenchAccess access,
                         TraceOwnerResolver owners, WorkbenchIdentityResolver identities, TraceStore traces,
                         PreviewSessions sessions) {
        this.providers = providers;
        this.stores = stores;
        this.access = access;
        this.owners = owners;
        this.identities = identities;
        this.traces = traces;
        this.sessions = sessions;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler)
            throws Exception {
        if (request.getAttribute(PreviewState.ATTRIBUTE) instanceof PreviewState preview) {
            return beginPreview(preview, request, response, handler);
        }
        if (request.getAttribute(ObservedState.ATTRIBUTE) instanceof ObservedState observed) {
            beginObservation(observed, request, response, handler);
        }
        return true;
    }

    private boolean beginPreview(PreviewState preview, HttpServletRequest request, HttpServletResponse response,
                                 Object handler) throws Exception {
        if (!(handler instanceof HandlerMethod method)) {
            // Static resources and other non-controller handlers are not preview targets.
            response.setStatus(HttpServletResponse.SC_NOT_FOUND);
            return false;
        }
        boolean sessionRead = preview.sessionId != null && "GET".equals(request.getMethod());
        if (!PreviewEligibility.allows(method, sessionRead) || preview.execution.hasInvoked()
                || request.getDispatcherType() != DispatcherType.REQUEST) {
            response.setStatus(HttpServletResponse.SC_CONFLICT);
            return false;
        }
        if (!SendproofFilter.isSameOrigin(request) || !access.permits(request)) {
            response.setStatus(HttpServletResponse.SC_FORBIDDEN);
            return false;
        }
        if (preview.sessionId != null) {
            try {
                preview.execution.join(sessions, preview.sessionId, sessionOwner(owners, identities, request));
            } catch (PreviewSessions.Refusal denied) {
                return false;
            }
        }
        // A Preview needs a SQL provider or at least one hooked data store, so a MongoDB-only or guard-only app can Preview.
        PreviewProvider provider = providers.get();
        if (provider == null && !stores.any()) {
            response.setStatus(HttpServletResponse.SC_SERVICE_UNAVAILABLE);
            return false;
        }
        preview.execution.begin(provider, stores.all());
        return true;
    }

    static TraceOwner sessionOwner(TraceOwnerResolver owners, WorkbenchIdentityResolver identities,
                                   HttpServletRequest request) {
        var owner = owners.resolve(request);
        var mount = WorkbenchController.mount(request);
        if (owner != null && !mount.equals(owner.mount())) {
            owner = new TraceOwner(owner.authenticationType(), owner.subject(), mount);
        }
        return PreviewSessions.owner(owner, request.getUserPrincipal() != null || identities.resolve(request) != null, mount);
    }

    private void beginObservation(ObservedState observed, HttpServletRequest request, HttpServletResponse response,
                                  Object handler) {
        if (observed.claimed || response.isCommitted() || !(handler instanceof HandlerMethod method)
                || !(PreviewEligibility.isMarked(method) || PreviewEligibility.isUnavailable(method))) {
            return;
        }
        TraceOwner owner = owners.resolve(request);
        if (owner == null) {
            return;
        }
        observed.claimed = true;
        PreviewObservation observation = null;
        try {
            PreviewProvider provider = access.permits(request) ? providers.get() : null;
            if (provider == null && !(stores.any() && access.permits(request))) {
                return;
            }
            observation = provider == null ? null : provider.beginObservation();
            observed.owner = owner;
            observed.execution = new ObservedExecution(observed.started, traces, owner, observation);
            observed.scope = CaptureContext.enter(observed.execution.capture());
            response.setHeader(Protocol.TRACE_HEADER, observed.execution.traceId());
            response.setHeader("Cache-Control", "no-store");
        } catch (Exception error) {
            LOG.warn("Sendproof could not start observing the send.", error);
            observed.execution = null;
            if (observation != null) {
                observation.close();
            }
        }
    }

    @Override
    public void postHandle(HttpServletRequest request, HttpServletResponse response, Object handler,
                           ModelAndView modelAndView) {
        if (request.getAttribute(ObservedState.ATTRIBUTE) instanceof ObservedState observed
                && observed.execution != null && !response.isCommitted()) {
            // Headers can only change before the response is written; this reflects the work done so far.
            response.setHeader("Server-Timing", observed.execution.timing().toHeader());
        }
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response, Object handler,
                                Exception error) {
        if (request.getAttribute(PreviewState.ATTRIBUTE) instanceof PreviewState preview) {
            // A resolved exception (validation, @ExceptionHandler) is an application response and is still confirmable;
            // an unresolved one reaches the filter as a failure.
            if (error == null) {
                preview.execution.markCompleted();
            }
            return;
        }
        if (request.getAttribute(ObservedState.ATTRIBUTE) instanceof ObservedState observed
                && observed.execution != null) {
            try {
                TraceOwner current = owners.resolve(request);
                observed.execution.finish(error == null && observed.owner.equals(current));
            } finally {
                observed.scope.close();
                observed.execution = null;
            }
        }
    }
}
