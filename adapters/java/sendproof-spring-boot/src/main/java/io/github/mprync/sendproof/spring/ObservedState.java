package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.ObservedExecution;
import io.github.mprync.sendproof.core.TraceOwner;

/** An ordinary send that asked for {@code Prefer: trace}, awaiting handler selection. */
final class ObservedState {
    static final String ATTRIBUTE = ObservedState.class.getName();

    final long started;
    boolean claimed;
    ObservedExecution execution;
    TraceOwner owner;
    CaptureContext.Scope scope;

    ObservedState(long started) {
        this.started = started;
    }
}
