package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.PreviewProvider;
import org.springframework.beans.factory.ObjectProvider;

/**
 * Resolves the single {@link PreviewProvider} for the application. With zero providers, or with several and none marked
 * {@code @Primary}, no preview is offered. An unavailable provider is treated as absent.
 */
final class PreviewProviders {
    private final ObjectProvider<PreviewProvider> providers;

    PreviewProviders(ObjectProvider<PreviewProvider> providers) {
        this.providers = providers;
    }

    /** Returns the usable provider, or {@code null}. */
    PreviewProvider get() {
        PreviewProvider provider = providers.getIfUnique();
        return provider != null && provider.isAvailable() ? provider : null;
    }
}
