package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.Capabilities;
import io.github.mprync.sendproof.core.Capabilities.AuthProvider;
import io.github.mprync.sendproof.core.Capabilities.OpenApiDocument;
import io.github.mprync.sendproof.core.Json;
import io.github.mprync.sendproof.core.TraceOwner;
import io.github.mprync.sendproof.core.TraceStore;
import io.github.mprync.sendproof.core.WorkbenchAssets;
import io.swagger.v3.oas.annotations.Hidden;
import jakarta.servlet.http.HttpServletRequest;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.core.env.Environment;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The workbench's own routes under {@code /sendproof}: the embedded UI, discovery and trace retrieval. They are ordinary
 * MVC handlers, so the host's Spring Security rules for {@code /sendproof/**} apply to them. They are hidden from OpenAPI.
 */
@Hidden
@RestController
@RequestMapping("/sendproof")
class WorkbenchController {
    private static final Pattern HEX_ID = Pattern.compile("[0-9a-fA-F]{32}");

    private final SendproofSettings settings;
    private final Environment environment;
    private final PreviewProviders providers;
    private final PreviewOperations operations;
    private final OpenApiDocuments documents;
    private final WorkbenchIdentityResolver identities;
    private final WorkbenchAccess access;
    private final TraceOwnerResolver owners;
    private final TraceStore traces;
    private final WorkbenchAssets assets;

    WorkbenchController(SendproofSettings settings, Environment environment, PreviewProviders providers,
                        PreviewOperations operations, OpenApiDocuments documents,
                        WorkbenchIdentityResolver identities, WorkbenchAccess access, TraceOwnerResolver owners,
                        TraceStore traces, WorkbenchAssets assets) {
        this.settings = settings;
        this.environment = environment;
        this.providers = providers;
        this.operations = operations;
        this.documents = documents;
        this.identities = identities;
        this.access = access;
        this.owners = owners;
        this.traces = traces;
        this.assets = assets;
    }

    /** {@code GET /sendproof} redirects to the trailing-slash URL so relative asset links resolve. */
    @GetMapping("")
    ResponseEntity<Void> redirect(HttpServletRequest request) {
        if (!access.permits(request)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        String query = request.getQueryString() == null ? "" : "?" + request.getQueryString();
        return ResponseEntity.status(HttpStatus.FOUND)
                .header(HttpHeaders.LOCATION, request.getContextPath() + "/sendproof/" + query).build();
    }

    @GetMapping("/")
    ResponseEntity<byte[]> index(HttpServletRequest request) {
        return asset(request, "index.html");
    }

    @GetMapping("/signin.html")
    ResponseEntity<byte[]> signIn(HttpServletRequest request) {
        return asset(request, "index.html");
    }

    @GetMapping("/{*path}")
    ResponseEntity<byte[]> assetByPath(HttpServletRequest request, @PathVariable String path) {
        return asset(request, path.startsWith("/") ? path.substring(1) : path);
    }

    private ResponseEntity<byte[]> asset(HttpServletRequest request, String path) {
        if (!access.permits(request)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        var asset = assets.find(path.isEmpty() ? "index.html" : path);
        if (asset.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        String etag = asset.get().etag();
        var headers = new HttpHeaders();
        headers.setCacheControl(CacheControl.noCache());
        headers.set("X-Content-Type-Options", "nosniff");
        headers.setETag(etag);
        if (etag.equals(request.getHeader(HttpHeaders.IF_NONE_MATCH))) {
            return ResponseEntity.status(HttpStatus.NOT_MODIFIED).headers(headers).build();
        }
        return ResponseEntity.ok().headers(headers).contentType(MediaType.parseMediaType(asset.get().contentType()))
                .body(asset.get().bytes());
    }

    /** Discovery: the capabilities object for the current request. */
    @GetMapping("/_api/capabilities")
    ResponseEntity<byte[]> capabilities(HttpServletRequest request) throws java.io.IOException {
        if (!access.permits(request)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        String mount = request.getContextPath();
        var provider = providers.get();
        var previewOperations = provider == null ? List.<Capabilities.PreviewOperation>of()
                : List.copyOf(operations.list());
        var openApiUrl = mount + documents.primaryUrl();
        var docs = new ArrayList<OpenApiDocument>();
        for (OpenApiDocument document : documents.documents()) {
            docs.add(new OpenApiDocument(document.name(), mount + document.url()));
        }
        String apiName = settings.apiName() != null ? settings.apiName()
                : environment.getProperty("spring.application.name", "API");
        if (docs.stream().noneMatch(document -> document.url().equals(openApiUrl))) {
            docs.add(0, new OpenApiDocument(apiName, openApiUrl));
        }
        var providersList = new ArrayList<AuthProvider>();
        for (var configured : settings.authProviders()) {
            providersList.add(new AuthProvider(configured.label(), configured.kind(),
                    configured.url() == null ? null : mount + configured.url()));
        }
        var body = new Capabilities(1, openApiUrl, settings.fieldModules().stream()
                .map(module -> mount + module).toList(), apiName, environmentName(),
                provider == null ? null : provider.database(), identities.resolve(request), providersList,
                previewOperations, !previewOperations.isEmpty(), docs);
        return json(Json.MAPPER.writeValueAsBytes(body));
    }

    /** Reads the trace of an observed send; only its owner can. */
    @GetMapping("/_api/traces/{id}")
    ResponseEntity<byte[]> trace(HttpServletRequest request, @PathVariable String id) throws java.io.IOException {
        UUID traceId = parse(id);
        TraceOwner owner = owners.resolve(request);
        if (traceId == null || owner == null || !access.permits(request) || !SendproofFilter.isSameOrigin(request)) {
            return noStore(ResponseEntity.status(HttpStatus.NOT_FOUND)).build();
        }
        var trace = traces.read(traceId, owner);
        return trace.isEmpty() ? noStore(ResponseEntity.status(HttpStatus.NOT_FOUND)).build()
                : json(Json.MAPPER.writeValueAsBytes(trace.get()));
    }

    String environmentName() {
        if (settings.environment() != null) {
            return settings.environment();
        }
        String[] active = environment.getActiveProfiles();
        return active.length > 0 ? active[0] : "default";
    }

    private static UUID parse(String id) {
        String hex = id.replace("-", "");
        if (!HEX_ID.matcher(hex).matches()) {
            return null;
        }
        return UUID.fromString(hex.substring(0, 8) + "-" + hex.substring(8, 12) + "-" + hex.substring(12, 16) + "-"
                + hex.substring(16, 20) + "-" + hex.substring(20));
    }

    private static ResponseEntity<byte[]> json(byte[] body) {
        return noStore(ResponseEntity.ok()).contentType(MediaType.APPLICATION_JSON).body(body);
    }

    private static ResponseEntity.BodyBuilder noStore(ResponseEntity.BodyBuilder builder) {
        return builder.cacheControl(CacheControl.noStore()).header("X-Content-Type-Options", "nosniff");
    }
}
