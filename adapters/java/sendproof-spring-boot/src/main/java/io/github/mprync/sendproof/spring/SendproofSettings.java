package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.Capabilities.AuthProvider;
import io.github.mprync.sendproof.core.Capabilities.OpenApiDocument;
import io.github.mprync.sendproof.core.DataStore;
import io.github.mprync.sendproof.core.JourneyFiles;
import io.github.mprync.sendproof.core.LocalUrl;
import java.time.Duration;
import java.util.List;

/**
 * The settings the workbench actually uses: each value is the {@link Sendproof} builder's if set, otherwise the
 * {@code sendproof.*} property, otherwise the default. See {@link Sendproof} for the full precedence rules.
 *
 * @param apiName        the API display name, or {@code null} to fall back to {@code spring.application.name}
 * @param environment    the environment label, or {@code null} to fall back to the first active profile
 * @param openApiUrl     the explicit primary OpenAPI URL, or {@code null} to discover it
 * @param documents      explicit OpenAPI documents
 * @param authProviders  sign-in options
 * @param fieldModules   field renderer modules
 * @param traceRetention how long traces stay readable
 * @param filterOrder    the servlet filter order
 * @param dataStores     the data stores registered on the builder
 */
record SendproofSettings(String apiName, String environment, String openApiUrl, List<OpenApiDocument> documents,
                         List<AuthProvider> authProviders, List<String> fieldModules, Duration traceRetention,
                         int filterOrder, List<DataStore> dataStores, JourneyFiles journeys) {

    /** Merges the builder (which may be {@code null}) over the bound properties. */
    static SendproofSettings resolve(SendproofProperties properties, Sendproof builder) {
        List<OpenApiDocument> documents = builder != null && builder.documents() != null ? builder.documents()
                : properties.getDocuments().stream()
                .map(document -> new OpenApiDocument(document.getName(), LocalUrl.validate(document.getUrl()))).toList();
        List<AuthProvider> providers = builder != null && builder.authProviders() != null ? builder.authProviders()
                : properties.getAuthProviders().stream().map(provider -> new AuthProvider(provider.getLabel(),
                        provider.getKind(), provider.getUrl() == null ? null : LocalUrl.validate(provider.getUrl()))).toList();
        List<String> modules = builder != null && builder.fieldModules() != null ? builder.fieldModules()
                : properties.getFieldModules().stream().map(LocalUrl::validate).toList();
        return new SendproofSettings(
                first(builder == null ? null : builder.apiName(), properties.getApiName()),
                first(builder == null ? null : builder.environment(), properties.getEnvironment()),
                first(builder == null ? null : builder.openApiUrl(), properties.getOpenApiUrl() == null ? null
                        : LocalUrl.validate(properties.getOpenApiUrl())),
                documents, providers, modules,
                builder != null && builder.traceRetention() != null ? builder.traceRetention()
                        : properties.getTrace().getRetention(),
                properties.getFilterOrder(), builder == null ? List.of() : builder.dataStores(),
                builder == null ? new JourneyFiles() : builder.journeys().snapshot());
    }

    private static <T> T first(T preferred, T fallback) {
        return preferred != null ? preferred : fallback;
    }
}
