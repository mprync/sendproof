package dev.testbench.spring;

import dev.testbench.core.CaptureContext;
import dev.testbench.core.ObservedExecution;
import dev.testbench.core.TraceOwner;

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
