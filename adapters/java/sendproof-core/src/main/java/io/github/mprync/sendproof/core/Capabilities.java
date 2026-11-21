package io.github.mprync.sendproof.core;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * The discovery response served at {@code /sendproof/_api/capabilities}. It never contains connection strings, credentials
 * or database host secrets.
 *
 * @param protocolVersion   always {@code 1}
 * @param openApiUrl        the primary OpenAPI document URL, including the mount prefix
 * @param fieldModules      same-origin ES modules that add field renderers, in load order
 * @param apiName           the display name of the API
 * @param environment       a display label for the environment
 * @param database          a display label for the database, or {@code null}
 * @param identity          the identity on the current request, or {@code null} when anonymous
 * @param authProviders     sign-in options
 * @param previewOperations operations that may be previewed or observed
 * @param observedSend      whether {@code Prefer: trace} is supported for the preview operations
 * @param documents         every OpenAPI document
 */
public record Capabilities(int protocolVersion, String openApiUrl, List<String> fieldModules, String apiName,
                           String environment, String database, Identity identity, List<AuthProvider> authProviders,
                           List<PreviewOperation> previewOperations, boolean observedSend,
                           List<OpenApiDocument> documents) {

    /** The authenticated identity shown in the workbench. */
    public record Identity(String name, @JsonInclude(JsonInclude.Include.NON_NULL) String role) {
    }

    /** A sign-in option. {@code url} may be {@code null} for non-interactive handlers. */
    public record AuthProvider(String label, String kind, String url) {
    }

    /** An operation that supports preview, as an OpenAPI path template and verb. */
    public record PreviewOperation(String method, String path) {
    }

    /** A named OpenAPI document. */
    public record OpenApiDocument(String name, String url) {
    }
}
