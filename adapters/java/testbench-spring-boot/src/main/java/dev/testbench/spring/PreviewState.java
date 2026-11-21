package dev.testbench.spring;

import dev.testbench.core.PreviewExecution;

/** The preview in progress on a request, shared between the filter and the handler interceptor. */
final class PreviewState {
    static final String ATTRIBUTE = PreviewState.class.getName();

    final PreviewExecution execution;

    PreviewState(PreviewExecution execution) {
        this.execution = execution;
    }
}
