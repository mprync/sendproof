package dev.testbench.ktor

import io.ktor.server.routing.Route
import io.ktor.server.routing.RouteSelector
import io.ktor.server.routing.RouteSelectorEvaluation
import io.ktor.server.routing.RoutingResolveContext
import io.ktor.util.AttributeKey

internal val PreviewableKey: AttributeKey<Unit> = AttributeKey("TestBench.Previewable")

private object PreviewableSelector : RouteSelector() {
    override suspend fun evaluate(context: RoutingResolveContext, segmentIndex: Int): RouteSelectorEvaluation =
        RouteSelectorEvaluation.Transparent

    override fun toString(): String = "(testbench-preview)"
}

/**
 * Marks the routes declared in [build] as safe to preview and observe. It does not change how they are matched.
 *
 * ```kotlin
 * route("/items") {
 *     testBenchPreview {
 *         post { /* writes through the PreviewDataSource */ }
 *     }
 * }
 * ```
 *
 * An eligible operation must reach its database through a `PreviewDataSource` and hold back external effects through
 * `TestBenchCapture`. Authentication and authorization must run before the handler (in route-scoped plugins), because
 * the preview begins immediately before it.
 */
public fun Route.testBenchPreview(build: Route.() -> Unit): Route {
    val child = createChild(PreviewableSelector)
    child.attributes.put(PreviewableKey, Unit)
    child.build()
    return child
}

/** Returns whether this route, or one of its parents, was declared with [testBenchPreview]. */
internal fun Route.isPreviewable(): Boolean = generateSequence(this) { it.parent }.any { it.attributes.contains(PreviewableKey) }
