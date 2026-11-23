package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.PreviewExecution;

/** The preview in progress on a request, shared between the filter and the handler interceptor. */
final class PreviewState {
    static final String ATTRIBUTE = PreviewState.class.getName();

    final PreviewExecution execution;
    final String sessionId;

    PreviewState(PreviewExecution execution, String sessionId) {
        this.execution = execution;
        this.sessionId = sessionId;
    }
}
