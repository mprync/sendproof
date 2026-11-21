package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.Capabilities.OpenApiDocument;
import io.github.mprync.sendproof.core.LocalUrl;
import java.util.List;

/** OpenAPI documents taken from the settings ({@code sendproof.open-api-url}/{@code documents} or the builder). */
final class PropertyOpenApiDocuments implements OpenApiDocuments {
    private final String primary;
    private final List<OpenApiDocument> documents;

    PropertyOpenApiDocuments(SendproofSettings settings, String fallback) {
        this.primary = LocalUrl.validate(settings.openApiUrl() != null ? settings.openApiUrl() : fallback);
        this.documents = settings.documents();
    }

    @Override
    public String primaryUrl() {
        return primary;
    }

    @Override
    public List<OpenApiDocument> documents() {
        return documents;
    }
}
