package io.github.mprync.sendproof.ktor

import io.github.mprync.sendproof.core.Json
import io.github.mprync.sendproof.core.ObservedExecution
import io.github.mprync.sendproof.core.PreviewExecution
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.response.header
import io.ktor.server.response.respondBytes
import io.ktor.util.AttributeKey

/** Carried on the inner call of a preview so the route gate can find its execution. */
internal class PreviewState(val execution: PreviewExecution)

/** Carried on an ordinary call that asked for `Prefer: trace`, until the route gate decides to observe it. */
internal class ObservedCandidate(val started: Long) {
    var execution: ObservedExecution? = null
}

internal val PreviewStateKey: AttributeKey<PreviewState> = AttributeKey("Sendproof.Preview")
internal val ObservedKey: AttributeKey<ObservedCandidate> = AttributeKey("Sendproof.Observed")

/** Writes an RFC 9457 problem response that never caches and never claims a rollback. */
internal suspend fun ApplicationCall.respondProblem(status: Int, title: String, challenge: String? = null) {
    response.header("Cache-Control", "no-store")
    if (challenge != null) {
        response.header("WWW-Authenticate", challenge)
    }
    val body = Json.MAPPER.writeValueAsBytes(linkedMapOf("type" to "about:blank", "title" to title, "status" to status))
    respondBytes(body, ContentType.parse("application/problem+json; charset=UTF-8"), HttpStatusCode.fromValue(status))
}
