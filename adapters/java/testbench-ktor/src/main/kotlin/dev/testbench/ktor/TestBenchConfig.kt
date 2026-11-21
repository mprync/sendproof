package dev.testbench.ktor

import dev.testbench.core.Capabilities
import dev.testbench.core.PreviewProvider
import dev.testbench.core.TraceOwner
import dev.testbench.core.TraceStore
import io.ktor.server.application.ApplicationCall
import java.time.Duration

/**
 * Configuration for the [TestBench] plugin. Everything is off unless [enabled] is set, so production builds can leave
 * the plugin installed and decide per environment.
 */
public class TestBenchConfig {
    /** Master opt-in. When false the plugin registers nothing: no routes, no preview, no capture. */
    public var enabled: Boolean = false

    /**
     * The application mount, empty or such as `/tenant`. The workbench lives at `<pathBase>/bench/`. Routes you declare
     * yourself must use the same prefix.
     */
    public var pathBase: String = ""

    /** Display label for the environment. */
    public var environment: String = "Development"

    /** Display name of the API. */
    public var apiName: String = "API"

    /** The primary OpenAPI document URL, relative to [pathBase]. */
    public var openApiUrl: String = "/openapi.json"

    /** Extra OpenAPI documents, relative to [pathBase]. */
    public val documents: MutableList<Capabilities.OpenApiDocument> = mutableListOf()

    /** Sign-in options. URLs are relative to [pathBase]. */
    public val authProviders: MutableList<Capabilities.AuthProvider> = mutableListOf()

    /** Same-origin ES modules that add field renderers, relative to [pathBase]. */
    public val fieldModules: MutableList<String> = mutableListOf()

    /** How long an observed send's trace stays readable. */
    public var traceRetention: Duration = TraceStore.DEFAULT_RETENTION

    /** Copies Logback log events into previews and traces when Logback is the logging backend. */
    public var captureLogs: Boolean = true

    /** The data-layer provider, for example `JdbcPreviewProvider`. Without one no operation is previewable. */
    public var provider: PreviewProvider? = null

    /** Resolves the identity shown in the workbench, or null for an anonymous caller. */
    public var identity: (ApplicationCall) -> Capabilities.Identity? = { null }

    /** Resolves who may read an observed send's trace. Null means the caller has no stable authenticated subject. */
    public var traceOwner: (ApplicationCall) -> TraceOwner? = { null }

    /** An extra gate for the workbench and every preview and observed send, evaluated after your own authorization. */
    public var access: (ApplicationCall) -> Boolean = { true }
}
