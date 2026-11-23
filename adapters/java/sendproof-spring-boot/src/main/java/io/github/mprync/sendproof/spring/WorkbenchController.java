package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.Capabilities;
import io.github.mprync.sendproof.core.Capabilities.AuthProvider;
import io.github.mprync.sendproof.core.Capabilities.OpenApiDocument;
import io.github.mprync.sendproof.core.DataStore;
import io.github.mprync.sendproof.core.Json;
import io.github.mprync.sendproof.core.JourneyFiles;
import io.github.mprync.sendproof.core.PreviewSessions;
import io.github.mprync.sendproof.core.TraceOwner;
import io.github.mprync.sendproof.core.TraceStore;
import io.github.mprync.sendproof.core.WorkbenchAssets;
import io.swagger.v3.oas.annotations.Hidden;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.MappingMatch;
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
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
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
    private final SendproofStores stores;
    private final PreviewOperations operations;
    private final OpenApiDocuments documents;
    private final WorkbenchIdentityResolver identities;
    private final WorkbenchAccess access;
    private final TraceOwnerResolver owners;
    private final TraceStore traces;
    private final WorkbenchAssets assets;
    private final PreviewSessions sessions;
    private final UnguardedClients unguarded;

    WorkbenchController(SendproofSettings settings, Environment environment, PreviewProviders providers,
                        SendproofStores stores, PreviewOperations operations, OpenApiDocuments documents,
                        WorkbenchIdentityResolver identities, WorkbenchAccess access, TraceOwnerResolver owners,
                        TraceStore traces, WorkbenchAssets assets, PreviewSessions sessions, UnguardedClients unguarded) {
        this.settings = settings;
        this.environment = environment;
        this.providers = providers;
        this.stores = stores;
        this.operations = operations;
        this.documents = documents;
        this.identities = identities;
        this.access = access;
        this.owners = owners;
        this.traces = traces;
        this.assets = assets;
        this.sessions = sessions;
        this.unguarded = unguarded;
    }

    /** {@code GET /sendproof} redirects to the trailing-slash URL so relative asset links resolve. */
    @GetMapping("")
    ResponseEntity<Void> redirect(HttpServletRequest request) {
        if (!access.permits(request)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        String query = request.getQueryString() == null ? "" : "?" + request.getQueryString();
        return ResponseEntity.status(HttpStatus.FOUND)
                .header(HttpHeaders.LOCATION, mount(request) + "/sendproof/" + query).build();
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
        if (JourneyFiles.matches(path)) {
            var document = settings.journeys().find(path, mount(request));
            return document == null ? noStore(ResponseEntity.status(HttpStatus.NOT_FOUND)).build() : json(document.toString()
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8));
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
        String mount = mount(request);
        var provider = providers.get();
        // A hooked data store is enough to Preview, so an application without a SQL provider still lists its operations.
        boolean canPreview = provider != null || stores.any();
        var previewOperations = canPreview ? List.copyOf(operations.list()) : List.<Capabilities.PreviewOperation>of();
        var unavailable = canPreview ? operations.unavailable() : List.<Capabilities.PreviewUnavailable>of();
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
                database(provider), identities.resolve(request), providersList,
                previewOperations, !previewOperations.isEmpty(), docs, describeStores(), unavailable,
                new Capabilities.Binding("java", "Spring Boot"), sessionsSupported(provider),
                settings.journeys().discover(mount));
        return json(Json.MAPPER.writeValueAsBytes(body));
    }

    private boolean sessionsSupported(io.github.mprync.sendproof.core.PreviewProvider provider) {
        return unguarded.block() == null && PreviewSessions.supported(provider, stores.all());
    }

    @PostMapping("/_api/sessions")
    ResponseEntity<?> openSession(HttpServletRequest request) {
        if (!access.permits(request) || !SendproofFilter.isSameOrigin(request)) {
            return sessionProblem(new PreviewSessions.Refusal(403, null, "Preview session access was refused."));
        }
        try {
            var provider = providers.get();
            if (!sessionsSupported(provider)) {
                throw new PreviewSessions.Refusal(409, null, "Preview sessions are unavailable for this host's stores.");
            }
            var opened = sessions.open(SendproofInterceptor.sessionOwner(owners, identities, request), provider, stores.all());
            return noStore(ResponseEntity.status(HttpStatus.CREATED)).contentType(MediaType.APPLICATION_JSON).body(opened);
        } catch (PreviewSessions.Refusal refused) {
            return sessionProblem(refused);
        }
    }

    @PostMapping("/_api/sessions/{id}/rewind")
    ResponseEntity<?> rewindSession(HttpServletRequest request, @PathVariable String id) throws java.io.IOException {
        try (var lease = enterSession(request, id)) {
            var input = request.getInputStream().readNBytes(1025);
            lease.rewind(input.length > 1024 ? 0 : PreviewSessions.rewindStep(input));
            return noStore(ResponseEntity.status(HttpStatus.NO_CONTENT)).build();
        } catch (PreviewSessions.Refusal refused) {
            return sessionProblem(refused);
        }
    }

    @DeleteMapping("/_api/sessions/{id}")
    ResponseEntity<?> endSession(HttpServletRequest request, @PathVariable String id) {
        try (var lease = enterSession(request, id)) {
            lease.end();
            return noStore(ResponseEntity.status(HttpStatus.NO_CONTENT)).build();
        } catch (PreviewSessions.Refusal refused) {
            return sessionProblem(refused);
        }
    }

    private PreviewSessions.Lease enterSession(HttpServletRequest request, String id) {
        if (!access.permits(request) || !SendproofFilter.isSameOrigin(request)) {
            throw PreviewSessions.notFound();
        }
        return sessions.enter(id, SendproofInterceptor.sessionOwner(owners, identities, request));
    }

    private static ResponseEntity<byte[]> sessionProblem(PreviewSessions.Refusal refused) {
        var outcome = refused.outcome();
        return noStore(ResponseEntity.status(outcome.status())).contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .body(outcome.problem());
    }

    static String mount(HttpServletRequest request) {
        return request.getContextPath() + (request.getHttpServletMapping().getMappingMatch() == MappingMatch.PATH
                ? request.getServletPath() : "");
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

    /** The SQL database as {@code { name, system }}, or just the name when the provider can't say which system it is. */
    private static Object database(io.github.mprync.sendproof.core.PreviewProvider provider) {
        if (provider == null) {
            return null;
        }
        String system = provider.databaseSystem();
        return system == null ? provider.database() : new Capabilities.Database(provider.database(), system);
    }

    /** Each hooked store and its mode. A store that can't describe itself is reported as guarded, never left out. */
    private List<DataStore.Description> describeStores() {
        var described = new ArrayList<DataStore.Description>();
        for (DataStore store : stores.all()) {
            try {
                described.add(store.describe());
            } catch (RuntimeException error) {
                described.add(new DataStore.Description(store.system(), null, "guard", null));
            }
        }
        return described;
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
