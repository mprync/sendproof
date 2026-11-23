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
 * @param dataStores        the data stores the binding has hooked and how Preview treats each
 * @param previewUnavailable operations marked {@code preview: false}, each with the reason the workbench shows
 * @param binding           the language and framework serving the workbench, or {@code null}
 * @param previewSessions   whether every rollback-capable store supports held Preview sessions
 * @param journeys          the registered journey document pairs
 */
public record Capabilities(int protocolVersion, String openApiUrl, List<String> fieldModules, String apiName,
                           String environment, Object database, Identity identity, List<AuthProvider> authProviders,
                           List<PreviewOperation> previewOperations, boolean observedSend,
                           List<OpenApiDocument> documents,
                           @JsonInclude(JsonInclude.Include.NON_EMPTY) List<DataStore.Description> dataStores,
                           @JsonInclude(JsonInclude.Include.NON_EMPTY) List<PreviewUnavailable> previewUnavailable,
                           @JsonInclude(JsonInclude.Include.NON_NULL) Binding binding,
                           boolean previewSessions,
                           @JsonInclude(JsonInclude.Include.NON_EMPTY) List<Journey> journeys) {

    public Capabilities(int protocolVersion, String openApiUrl, List<String> fieldModules, String apiName,
                        String environment, Object database, Identity identity, List<AuthProvider> authProviders,
                        List<PreviewOperation> previewOperations, boolean observedSend, List<OpenApiDocument> documents,
                        List<DataStore.Description> dataStores, List<PreviewUnavailable> previewUnavailable, Binding binding) {
        this(protocolVersion, openApiUrl, fieldModules, apiName, environment, database, identity, authProviders,
                previewOperations, observedSend, documents, dataStores, previewUnavailable, binding, false, List.of());
    }

    /** Creates capabilities with no data stores, no unavailable operations and no binding. */
    public Capabilities(int protocolVersion, String openApiUrl, List<String> fieldModules, String apiName,
                        String environment, Object database, Identity identity, List<AuthProvider> authProviders,
                        List<PreviewOperation> previewOperations, boolean observedSend,
                        List<OpenApiDocument> documents) {
        this(protocolVersion, openApiUrl, fieldModules, apiName, environment, database, identity, authProviders,
                previewOperations, observedSend, documents, List.of(), List.of(), null);
    }

    /**
     * The SQL database as shown in the workbench.
     *
     * @param name   a short non-secret display name, or {@code null}
     * @param system the SQL provider id, such as {@code h2}, {@code postgresql}, {@code mysql}, {@code mssql} or
     *               {@code sqlite}, so the workbench shows that provider's mark
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Database(String name, String system) {
    }

    /** The binding that serves the workbench, so guidance is written in the host's own language. */
    public record Binding(String language, String framework) {
    }

    /** An operation marked {@code preview: false}, with the reason the workbench shows before anyone tries it. */
    public record PreviewUnavailable(String method, String path, String reason,
                                     @JsonInclude(JsonInclude.Include.NON_EMPTY) List<String> stores) {
    }

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

    /** A registered journey document and its paired expectations. */
    public record Journey(String name, String source, String arazzoUrl, String expectationsUrl) {
    }
}
