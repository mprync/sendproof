package dev.testbench.spring;

import dev.testbench.core.Capabilities.OpenApiDocument;
import dev.testbench.core.LocalUrl;
import java.util.ArrayList;
import java.util.List;
import org.springdoc.core.models.GroupedOpenApi;
import org.springframework.core.env.Environment;

/**
 * Discovers OpenAPI documents from springdoc: the configured {@code springdoc.api-docs.path} (default
 * {@code /v3/api-docs}) and one document per {@link GroupedOpenApi}. Explicit {@code testbench.open-api-url} and
 * {@code testbench.documents} win over discovery.
 */
final class SpringdocOpenApiDocuments implements OpenApiDocuments {
    private final String primary;
    private final List<OpenApiDocument> documents = new ArrayList<>();

    SpringdocOpenApiDocuments(Environment environment, TestBenchSettings settings, List<GroupedOpenApi> groups) {
        String base = environment.getProperty("springdoc.api-docs.path", "/v3/api-docs");
        boolean enabled = environment.getProperty("springdoc.api-docs.enabled", Boolean.class, true);
        documents.addAll(settings.documents());
        if (enabled) {
            for (GroupedOpenApi group : groups) {
                documents.add(new OpenApiDocument(group.getGroup(), LocalUrl.validate(base + "/" + group.getGroup())));
            }
        }
        if (settings.openApiUrl() != null) {
            primary = settings.openApiUrl();
        } else if (enabled && !groups.isEmpty()) {
            primary = LocalUrl.validate(base + "/" + groups.get(0).getGroup());
        } else {
            primary = LocalUrl.validate(base);
        }
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
