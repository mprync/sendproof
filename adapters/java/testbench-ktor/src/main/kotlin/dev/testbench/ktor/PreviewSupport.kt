package dev.testbench.ktor

import dev.testbench.core.Json
import dev.testbench.core.ObservedExecution
import dev.testbench.core.PreviewExecution
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

internal val PreviewStateKey: AttributeKey<PreviewState> = AttributeKey("TestBench.Preview")
internal val ObservedKey: AttributeKey<ObservedCandidate> = AttributeKey("TestBench.Observed")

/** Writes an RFC 9457 problem response that never caches and never claims a rollback. */
internal suspend fun ApplicationCall.respondProblem(status: Int, title: String, challenge: String? = null) {
    response.header("Cache-Control", "no-store")
    if (challenge != null) {
        response.header("WWW-Authenticate", challenge)
    }
    val body = Json.MAPPER.writeValueAsBytes(linkedMapOf("type" to "about:blank", "title" to title, "status" to status))
    respondBytes(body, ContentType.parse("application/problem+json; charset=UTF-8"), HttpStatusCode.fromValue(status))
}
