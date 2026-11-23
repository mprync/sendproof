package io.github.mprync.sendproof.ktor

import io.github.mprync.sendproof.core.Capabilities
import io.github.mprync.sendproof.core.DataStore
import io.github.mprync.sendproof.core.JourneyFiles
import io.github.mprync.sendproof.core.PreviewProvider
import io.github.mprync.sendproof.core.TraceOwner
import io.github.mprync.sendproof.core.TraceStore
import io.ktor.server.application.ApplicationCall
import java.time.Duration

/**
 * Configuration for the [Sendproof] plugin. Everything is off unless [enabled] is set, so production builds can leave
 * the plugin installed and decide per environment.
 */
public class SendproofConfig {
    /** Master opt-in. When false the plugin registers nothing: no routes, no preview, no capture. */
    public var enabled: Boolean = false

    /**
     * The application mount, empty or such as `/tenant`. The workbench lives at `<pathBase>/sendproof/`. Routes you declare
     * yourself must use the same prefix.
     */
    public var pathBase: String = ""

    /**
     * Display label for the environment. When unset it is "Development" in Ktor development mode and "Production"
     * otherwise, so an enabled workbench never labels a production process as development. It is only a label: SQL
     * parameter values are controlled by the `PreviewDataSource`'s `showValues`.
     */
    public var environment: String? = null

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

    /**
     * The data store hooks: `MongoStore`, `RedisStore` and `DynamoDbStore`. Registering one makes a Preview possible even
     * without a [provider], so a MongoDB-only or guard-only application can Preview.
     *
     * ```kotlin
     * dataStores += catalog          // a MongoStore, whose guarded client the handlers use
     * dataStores += cache            // a RedisStore
     * ```
     */
    public val dataStores: MutableList<DataStore> = mutableListOf()

    internal val journeys: JourneyFiles = JourneyFiles()

    /** Registers an Arazzo resource and its adjacent `.expect.json` file from the application classpath. */
    public fun journey(classpathResource: String) {
        journeys.registerResource(classpathResource, Thread.currentThread().contextClassLoader ?: javaClass.classLoader)
    }

    /** Registers an Arazzo file and its adjacent `.expect.json` file from the filesystem. */
    public fun journey(file: java.nio.file.Path) {
        journeys.register(file)
    }

    /** Resolves the identity shown in the workbench, or null for an anonymous caller. */
    public var identity: (ApplicationCall) -> Capabilities.Identity? = { null }

    /** Resolves who may read an observed send's trace. Null means the caller has no stable authenticated subject. */
    public var traceOwner: (ApplicationCall) -> TraceOwner? = { null }

    /** An extra gate for the workbench and every preview and observed send, evaluated after your own authorization. */
    public var access: (ApplicationCall) -> Boolean = { true }
}
