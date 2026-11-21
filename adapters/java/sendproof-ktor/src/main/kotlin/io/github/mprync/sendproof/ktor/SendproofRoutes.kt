package io.github.mprync.sendproof.ktor

import io.ktor.server.routing.Route
import io.ktor.server.routing.RouteSelector
import io.ktor.server.routing.RouteSelectorEvaluation
import io.ktor.server.routing.RoutingResolveContext
import io.ktor.util.AttributeKey

internal val PreviewableKey: AttributeKey<Unit> = AttributeKey("Sendproof.Previewable")

/** Why an operation is marked `enabled = false`, and the stores it writes. */
internal class Unavailable(val reason: String, val stores: List<String>)

internal val UnavailableKey: AttributeKey<Unavailable> = AttributeKey("Sendproof.Unavailable")

/**
 * A transparent marker node. Every [sendproofPreview] call makes its own, because Ktor reuses a child whose selector equals
 * an existing one, which would merge an `enabled = false` block into a sibling block that is enabled.
 */
private class PreviewableSelector : RouteSelector() {
    override suspend fun evaluate(context: RoutingResolveContext, segmentIndex: Int): RouteSelectorEvaluation =
        RouteSelectorEvaluation.Transparent

    override fun toString(): String = "(sendproof-preview)"
}

/**
 * Marks the routes declared in [build] as safe to preview and observe. It does not change how they are matched.
 *
 * ```kotlin
 * route("/items") {
 *     sendproofPreview {
 *         post { /* writes through the PreviewDataSource */ }
 *     }
 * }
 * ```
 *
 * An eligible operation must reach its database through a `PreviewDataSource` and hold back external effects through
 * `SendproofCapture`. Authentication and authorization must run before the handler (in route-scoped plugins), because
 * the preview begins immediately before it.
 *
 * An operation that writes a data store that can't roll back (Redis, DynamoDB, MongoDB on a standalone server) can be
 * marked `enabled = false`. It is then not advertised as previewable, the workbench shows "Preview unavailable" with the
 * [reason] before anyone tries, and a Preview of it never runs the handler. Sendproof never infers this mark: without it
 * the operation is advertised and the write guard decides at run time, which is also safe.
 *
 * ```kotlin
 * sendproofPreview(enabled = false, reason = "Clears the Redis session") { delete("/sessions/{id}") { /* ... */ } }
 * ```
 *
 * @param enabled `false` publishes the routes in [build] as unavailable
 * @param reason the sentence the workbench shows; required for `enabled = false` unless [stores] names a store, in which case
 *   it defaults to "Preview unavailable: this operation writes to <Store>"
 * @param stores the stores an unavailable operation writes, as store ids such as `redis`, `dynamodb` or `mongodb`
 */
public fun Route.sendproofPreview(
    enabled: Boolean = true,
    reason: String? = null,
    stores: List<String> = emptyList(),
    build: Route.() -> Unit,
): Route {
    val child = createChild(PreviewableSelector())
    if (enabled) {
        child.attributes.put(PreviewableKey, Unit)
    } else {
        val text = reason?.takeIf { it.isNotBlank() }
            ?: stores.firstOrNull()?.let { io.github.mprync.sendproof.core.stores.StoreGuard.writeReason(it) }
        require(text != null && text.length <= 512) {
            "sendproofPreview(enabled = false) needs a reason of at most 512 characters, or the stores it writes."
        }
        child.attributes.put(UnavailableKey, Unavailable(text, stores))
    }
    child.build()
    return child
}

/** Returns whether this route, or one of its parents, was declared with [sendproofPreview]. */
internal fun Route.isPreviewable(): Boolean = generateSequence(this) { it.parent }.any { it.attributes.contains(PreviewableKey) }

/** The `enabled = false` mark on this route or the nearest parent that has one, or null. */
internal fun Route.unavailable(): Unavailable? =
    generateSequence(this) { it.parent }.firstNotNullOfOrNull { it.attributes.getOrNull(UnavailableKey) }
