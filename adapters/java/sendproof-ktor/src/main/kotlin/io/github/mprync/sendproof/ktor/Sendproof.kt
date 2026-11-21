package io.github.mprync.sendproof.ktor

import io.github.mprync.sendproof.core.Capabilities
import io.github.mprync.sendproof.core.CaptureContext
import io.github.mprync.sendproof.core.DataStore
import io.github.mprync.sendproof.core.Json
import io.github.mprync.sendproof.core.LocalUrl
import io.github.mprync.sendproof.core.ObservedExecution
import io.github.mprync.sendproof.core.PreviewExecution
import io.github.mprync.sendproof.core.PreviewOutcome
import io.github.mprync.sendproof.core.Protocol
import io.github.mprync.sendproof.core.TraceStore
import io.github.mprync.sendproof.core.WorkbenchAssets
import io.github.mprync.sendproof.logback.LogbackCapture
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.withCharset
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.ApplicationCallPipeline
import io.ktor.server.application.ApplicationPlugin
import io.ktor.server.application.ApplicationStopped
import io.ktor.server.application.PipelineCall
import io.ktor.server.application.call
import io.ktor.server.application.createApplicationPlugin
import io.ktor.server.request.httpMethod
import io.ktor.server.request.path
import io.ktor.server.request.uri
import io.ktor.server.response.ApplicationSendPipeline
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.response.respondBytes
import io.ktor.server.routing.HttpMethodRouteSelector
import io.ktor.server.routing.OpenApiRoutePathFormat
import io.ktor.server.routing.Route
import io.ktor.server.routing.RoutingPipelineCall
import io.ktor.server.routing.get
import io.ktor.server.routing.getAllRoutes
import io.ktor.server.routing.intercept
import io.ktor.server.routing.path
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import io.ktor.server.routing.routingRoot
import io.ktor.util.pipeline.PipelineContext
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asContextElement
import kotlinx.coroutines.withContext
import org.slf4j.LoggerFactory

/**
 * The Sendproof plugin: serves the workbench under `<pathBase>/sendproof/`, answers `/sendproof/_preview/...` by replaying the
 * original operation in-process inside a rolled-back unit of work, and records traces for observed sends.
 *
 * ```kotlin
 * install(Sendproof) {
 *     enabled = environment.config.property("sendproof.enabled").getString().toBoolean()
 *     provider = JdbcPreviewProvider(previewDataSource) { "inventory_dev" }
 *     identity = { call -> /* ... */ null }
 * }
 * routing { route("/items") { sendproofPreview { post { /* ... */ } } } }
 * ```
 */
public val Sendproof: ApplicationPlugin<SendproofConfig> = createApplicationPlugin("Sendproof", ::SendproofConfig) {
    val config = pluginConfig
    if (config.enabled) {
        val logging = if (config.captureLogs) {
            try {
                LogbackCapture.install()
            } catch (_: LinkageError) {
                null // Logback is not on the classpath.
            }
        } else {
            null
        }
        if (logging != null) {
            application.monitor.subscribe(ApplicationStopped) { logging.close() }
        }
        val runtime = SendproofRuntime(application, config)
        application.intercept(ApplicationCallPipeline.Setup) { runtime.setup(this) }
        application.routing {
            // After authentication and authorization (the Plugins phase) and before the route's handler.
            @Suppress("DEPRECATION")
            intercept(ApplicationCallPipeline.Call) { runtime.gate(this) }
            if (config.pathBase.isEmpty()) {
                runtime.workbench(this)
            } else {
                route(config.pathBase) { runtime.workbench(this) }
            }
        }
    }
}

internal class SendproofRuntime(private val application: Application, private val config: SendproofConfig) {
    private val log = LoggerFactory.getLogger(Sendproof::class.java)
    private val store = TraceStore(config.traceRetention, System::nanoTime)
    private val assets = WorkbenchAssets(SendproofRuntime::class.java.classLoader)

    init {
        LocalUrl.validate(config.openApiUrl)
        config.fieldModules.forEach(LocalUrl::validate)
    }

    // ---- request interception ---------------------------------------------------------------------------------

    /** Runs first for every request: serves the preview route, and marks ordinary sends that ask for a trace. */
    suspend fun setup(context: PipelineContext<Unit, PipelineCall>) {
        val call = context.call
        if (call.attributes.contains(InnerCallKey)) {
            return
        }
        val started = System.nanoTime()
        val path = call.request.path()
        val prefer = call.request.headers.getAll("Prefer").orEmpty()
        val prefix = Protocol.previewPrefixIndex(path)
        if (prefix < 0 || path.substring(0, prefix) != config.pathBase) {
            if (call.request.httpMethod != HttpMethod.Head && Protocol.observedRequested(prefer) && sameOrigin(call)) {
                call.attributes.put(ObservedKey, ObservedCandidate(started))
            }
            if (Protocol.requestsRollback(prefer)) {
                call.respondProblem(400, "Use the Sendproof preview URL for rollback requests.")
                context.finish()
                return
            }
            // Every ordinary call is marked, so a data store write that belongs to no request (a background coroutine) can be
            // told apart from a Send while a Preview is open.
            withContext(CaptureContext.attributionHolder().asContextElement(true)) { context.proceed() }
            return
        }
        val target = path.substring(prefix + Protocol.PREVIEW_PREFIX.length)
        when {
            !Protocol.hasExactPreference(prefer) ->
                call.respondProblem(400, "A Sendproof preview requires Prefer: tx=rollback.")
            call.request.httpMethod == HttpMethod.Head -> call.respondProblem(405, "A preview requires a response body.")
            !Protocol.isValidTarget(target) -> call.respondProblem(400, "The Sendproof preview target is invalid.")
            // Refused before the inner call runs any plugin, so a cross-site page cannot drive one through a preview.
            !sameOrigin(call) -> call.respondProblem(403, "Cross-origin previews are refused.")
            else -> preview(context, config.pathBase + target, started)
        }
        context.finish()
    }

    private suspend fun preview(context: PipelineContext<Unit, PipelineCall>, rewritten: String, started: Long) {
        val call = context.call
        val query = call.request.uri.substringAfter('?', "")
        val inner = PreviewCall(application, call, rewritten + if (query.isEmpty()) "" else "?$query", call.coroutineContext)
        val execution = PreviewExecution(started)
        inner.attributes.put(InnerCallKey, true)
        inner.attributes.put(PreviewStateKey, PreviewState(execution))
        val scope = io.github.mprync.sendproof.jdbc.JdbcScope()
        var failure: Throwable? = null
        // The thread-locals follow the request across coroutine thread hops.
        val outcome = withContext(
            CaptureContext.holder().asContextElement(execution.capture()) +
                io.github.mprync.sendproof.jdbc.JdbcScope.holder().asContextElement(scope),
        ) {
            try {
                try {
                    application.execute(inner, Unit)
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Throwable) {
                    failure = error
                }
                inner.response.await()
            } catch (cancelled: CancellationException) {
                // A client that went away, a timeout or a cancelled parent job: the Preview is never confirmed, but every
                // store is still aborted, SQL rolled back and the MySQL Preview turn handed on before the cancellation
                // continues. NonCancellable lets the cleanup run in a coroutine that is already cancelled.
                withContext(NonCancellable + Dispatchers.IO) { execution.finish(inner.response.captured(), cancelled) }
                throw cancelled
            }
            // Rolling back and capturing store changes block on I/O, so they run off the request's event loop.
            withContext(Dispatchers.IO) { execution.finish(inner.response.captured(), failure) }
        }
        write(call, outcome)
    }

    private suspend fun write(call: ApplicationCall, outcome: PreviewOutcome) {
        if (outcome.blocked()) {
            // A guarded store refused a write: 409 problem+json, never a confirmation and without the handler's output.
            call.response.header("Cache-Control", "no-store")
            call.respondBytes(
                outcome.problem(), ContentType.parse("application/problem+json; charset=UTF-8"), HttpStatusCode.fromValue(outcome.status()),
            )
            return
        }
        if (!outcome.confirmed()) {
            call.respondProblem(outcome.status(), outcome.title(), outcome.challenge())
            return
        }
        call.response.header("Cache-Control", "no-store")
        call.response.header("Preference-Applied", Protocol.ROLLBACK_PREFERENCE)
        call.response.header("Server-Timing", outcome.serverTiming())
        call.respondBytes(outcome.json(), ContentType.Application.Json.withCharset(Charsets.UTF_8), HttpStatusCode.OK)
    }

    /** Runs inside the matched route, after the route's own authentication and authorization. */
    suspend fun gate(context: PipelineContext<Unit, PipelineCall>) {
        val call = context.call
        val route = (call as? RoutingPipelineCall)?.route
        if (route == null || call.response.isCommitted) {
            return
        }
        val preview = call.attributes.getOrNull(PreviewStateKey)
        when {
            preview != null -> previewGate(context, route, preview)
            else -> call.attributes.getOrNull(ObservedKey)?.let {
                if (route.isPreviewable() || route.unavailable() != null) observe(context, it)
            }
        }
    }

    private suspend fun previewGate(context: PipelineContext<Unit, PipelineCall>, route: Route, preview: PreviewState) {
        val call = context.call
        val reject = when {
            !route.isPreviewable() || preview.execution.hasInvoked() -> HttpStatusCode.Conflict
            !sameOrigin(call) || !config.access(call) -> HttpStatusCode.Forbidden
            else -> null
        }
        val provider = config.provider?.takeIf { it.isAvailable }
        // A Preview needs a SQL provider or at least one hooked data store, so a MongoDB-only or guard-only app can Preview.
        if (reject != null || (provider == null && config.dataStores.isEmpty())) {
            call.respond(reject ?: HttpStatusCode.ServiceUnavailable)
            context.finish()
            return
        }
        // Starting a transaction (a MongoDB session) blocks on I/O, so it runs off the event loop; the capture follows.
        withContext(Dispatchers.IO) { preview.execution.begin(provider, config.dataStores) }
        context.proceed()
        preview.execution.markCompleted()
    }

    private suspend fun observe(context: PipelineContext<Unit, PipelineCall>, candidate: ObservedCandidate) {
        val call = context.call
        val owner = config.traceOwner(call)
        val provider = config.provider?.takeIf { it.isAvailable }
        if (owner == null || (provider == null && config.dataStores.isEmpty()) || !config.access(call)) {
            return
        }
        val scope = io.github.mprync.sendproof.jdbc.JdbcScope()
        withContext(io.github.mprync.sendproof.jdbc.JdbcScope.holder().asContextElement(scope)) {
            val observation = try {
                provider?.beginObservation()
            } catch (error: Exception) {
                log.warn("Sendproof could not start observing the send.", error)
                context.proceed()
                return@withContext
            }
            val execution = ObservedExecution(candidate.started, store, owner, observation)
            call.response.header(Protocol.TRACE_HEADER, execution.traceId())
            call.response.header("Cache-Control", "no-store")
            call.response.pipeline.intercept(ApplicationSendPipeline.Before) {
                if (!call.response.isCommitted) {
                    call.response.header("Server-Timing", execution.timing().toHeader())
                }
            }
            var completed = false
            try {
                withContext(CaptureContext.holder().asContextElement(execution.capture())) { context.proceed() }
                completed = config.traceOwner(call) == owner
            } finally {
                execution.finish(completed)
            }
        }
    }

    private fun sameOrigin(call: ApplicationCall): Boolean = Protocol.isSameOrigin(
        call.request.headers["Sec-Fetch-Site"], call.request.headers.getAll("Origin").orEmpty(),
        call.request.local.scheme, call.request.headers[HttpHeaders.Host],
    )

    // ---- workbench routes -------------------------------------------------------------------------------------

    fun workbench(route: Route) {
        route.route("/sendproof") {
            get { redirect(call) }
            get("/") { asset(call, "index.html") }
            get("/signin.html") { asset(call, "index.html") }
            get("/_api/capabilities") { capabilities(call) }
            get("/_api/traces/{id}") { trace(call) }
            get("/{path...}") { asset(call, call.parameters.getAll("path").orEmpty().joinToString("/")) }
        }
    }

    private suspend fun redirect(call: ApplicationCall) {
        if (!config.access(call)) {
            return call.respond(HttpStatusCode.Forbidden)
        }
        val query = call.request.uri.substringAfter('?', "")
        call.response.header(HttpHeaders.Location, config.pathBase + "/sendproof/" + if (query.isEmpty()) "" else "?$query")
        call.respond(HttpStatusCode.Found)
    }

    private suspend fun asset(call: ApplicationCall, requested: String) {
        if (!config.access(call)) {
            return call.respond(HttpStatusCode.Forbidden)
        }
        val asset = assets.find(requested.ifEmpty { "index.html" }).orElse(null) ?: return call.respond(HttpStatusCode.NotFound)
        call.response.header(HttpHeaders.CacheControl, "no-cache")
        call.response.header("X-Content-Type-Options", "nosniff")
        call.response.header(HttpHeaders.ETag, asset.etag())
        if (call.request.headers[HttpHeaders.IfNoneMatch] == asset.etag()) {
            return call.respond(HttpStatusCode.NotModified)
        }
        call.respondBytes(asset.bytes(), ContentType.parse(asset.contentType()), HttpStatusCode.OK)
    }

    private suspend fun capabilities(call: ApplicationCall) {
        if (!config.access(call)) {
            return call.respond(HttpStatusCode.Forbidden)
        }
        val mount = config.pathBase
        val provider = config.provider?.takeIf { it.isAvailable }
        // A hooked data store is enough to Preview, so an application without a SQL provider still lists its operations.
        val canPreview = provider != null || config.dataStores.isNotEmpty()
        val operations = if (canPreview) previewOperations() else emptyList()
        val unavailable = if (canPreview) previewUnavailable() else emptyList()
        val openApiUrl = mount + config.openApiUrl
        val documents = config.documents.map { Capabilities.OpenApiDocument(it.name(), mount + it.url()) }.toMutableList()
        if (documents.none { it.url() == openApiUrl }) {
            documents.add(0, Capabilities.OpenApiDocument(config.apiName, openApiUrl))
        }
        // Describing a store may contact its server (MongoDB asks hello), so it runs off the event loop.
        val stores = withContext(Dispatchers.IO) { config.dataStores.map(::describe) }
        val database: Any? = provider?.let {
            it.databaseSystem()?.let { system -> Capabilities.Database(it.database(), system) } ?: it.database()
        }
        val body = Capabilities(
            1, openApiUrl, config.fieldModules.map { mount + it }, config.apiName,
            config.environment ?: if (application.developmentMode) "Development" else "Production",
            database, config.identity(call),
            config.authProviders.map { Capabilities.AuthProvider(it.label(), it.kind(), it.url()?.let { url -> mount + url }) },
            operations, operations.isNotEmpty(), documents, stores, unavailable, Capabilities.Binding("kotlin", "Ktor"),
        )
        json(call, Json.MAPPER.writeValueAsBytes(body))
    }

    /** A store that can't describe itself is reported as guarded, never left out. */
    private fun describe(store: DataStore): DataStore.Description = try {
        store.describe()
    } catch (error: RuntimeException) {
        DataStore.Description(store.system(), null, "guard", null)
    }

    private fun previewOperations(): List<Capabilities.PreviewOperation> =
        application.routingRoot.getAllRoutes().filter { it.isPreviewable() }.mapNotNull { route ->
            val method = generateSequence<Route>(route) { it.parent }
                .mapNotNull { (it.selector as? HttpMethodRouteSelector)?.method }.firstOrNull()
            if (method == null || method == HttpMethod.Head) {
                null
            } else {
                val path = route.path(OpenApiRoutePathFormat).removePrefix(config.pathBase)
                Capabilities.PreviewOperation(method.value, path.ifEmpty { "/" })
            }
        }.distinct().sortedWith(compareBy({ it.path() }, { it.method() }))

    /** The operations marked `sendproofPreview(enabled = false)`, with the reason the workbench shows. */
    private fun previewUnavailable(): List<Capabilities.PreviewUnavailable> =
        application.routingRoot.getAllRoutes().mapNotNull { route ->
            val mark = route.unavailable() ?: return@mapNotNull null
            val method = generateSequence<Route>(route) { it.parent }
                .mapNotNull { (it.selector as? HttpMethodRouteSelector)?.method }.firstOrNull()
            if (method == null || method == HttpMethod.Head) {
                null
            } else {
                val path = route.path(OpenApiRoutePathFormat).removePrefix(config.pathBase)
                Capabilities.PreviewUnavailable(method.value, path.ifEmpty { "/" }, mark.reason, mark.stores)
            }
        }.distinct().sortedWith(compareBy({ it.path() }, { it.method() }))

    private suspend fun trace(call: ApplicationCall) {
        val owner = config.traceOwner(call)
        val id = runCatching { UUID.fromString(dashed(call.parameters["id"].orEmpty())) }.getOrNull()
        val trace = if (owner != null && id != null && config.access(call) && sameOrigin(call)) {
            store.read(id, owner).orElse(null)
        } else {
            null
        }
        call.response.header("Cache-Control", "no-store")
        call.response.header("X-Content-Type-Options", "nosniff")
        if (trace == null) {
            call.respond(HttpStatusCode.NotFound)
        } else {
            json(call, Json.MAPPER.writeValueAsBytes(trace))
        }
    }

    private fun dashed(id: String): String {
        val hex = id.replace("-", "")
        return if (Regex("[0-9a-fA-F]{32}").matches(hex)) {
            "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}"
        } else {
            "invalid"
        }
    }

    private suspend fun json(call: ApplicationCall, bytes: ByteArray) {
        call.response.header("Cache-Control", "no-store")
        call.response.header("X-Content-Type-Options", "nosniff")
        call.respondBytes(bytes, ContentType.Application.Json, HttpStatusCode.OK)
    }
}
