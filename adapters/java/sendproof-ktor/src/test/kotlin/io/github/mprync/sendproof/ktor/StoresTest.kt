package io.github.mprync.sendproof.ktor

import com.fasterxml.jackson.databind.JsonNode
import io.github.mprync.sendproof.core.DataStore
import io.github.mprync.sendproof.core.DbEntry
import io.github.mprync.sendproof.core.Json
import io.github.mprync.sendproof.core.PreviewChange
import io.github.mprync.sendproof.core.RequestCapture
import io.github.mprync.sendproof.core.stores.CommandKind
import io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException
import io.github.mprync.sendproof.core.stores.StoreGuard
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.response.respondText
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** A store that only guards, standing in for Redis or DynamoDB: the plugin's own behavior around stores. */
private class FakeStore(val written: MutableList<String> = mutableListOf()) : DataStore {
    override fun system() = "redis"

    override fun describe() = DataStore.Description("redis", "cache", "guard", null)

    /** What a hook does for each command: guard it, log it, then send it. */
    fun command(name: String, kind: CommandKind) {
        StoreGuard.guard("redis", name, kind, null)
        io.github.mprync.sendproof.core.CaptureContext.current()?.db(DbEntry.of("redis", name).withTarget("k"))
        if (kind == CommandKind.WRITE) written += name
    }
}

/** A store that rolls back: it records a change when finished and refuses a handler commit. */
private class FakeTransactional : DataStore {
    var finished = 0

    override fun system() = "mongodb"

    override fun describe() = DataStore.Description("mongodb", "catalog", "preview", null)

    override fun begin(capture: RequestCapture) = object : io.github.mprync.sendproof.core.DataStoreSession {
        override fun finish(capture: RequestCapture) {
            finished++
            capture.change(PreviewChange("insert", "documents", mapOf("_id" to "d"), null, mapOf("_id" to "d"), "mongodb", "db", null))
        }

        override fun close() = Unit
    }
}

/** Counts what the plugin does to a store and a SQL provider, so a cleanup step that is skipped shows up. */
private class Cleanup : DataStore, io.github.mprync.sendproof.core.PreviewProvider {
    val steps = java.util.concurrent.CopyOnWriteArrayList<String>()

    override fun system() = "mongodb"

    override fun describe() = DataStore.Description("mongodb", "catalog", "preview", null)

    override fun begin(capture: RequestCapture) = object : io.github.mprync.sendproof.core.DataStoreSession {
        override fun finish(capture: RequestCapture) {
            steps += "store finish"
        }

        override fun close() {
            steps += "store close"
        }
    }

    override fun isAvailable() = true

    override fun begin() = object : io.github.mprync.sendproof.core.PreviewSession {
        override fun changes() = emptyList<PreviewChange>()

        override fun rollback() {
            steps += "sql rollback"
        }

        override fun close() {
            steps += "sql close"
        }
    }
}

class StoresTest {
    private fun Application.app(vararg stores: DataStore, swallow: Boolean = false, withProvider: Boolean = false) {
        install(Sendproof) {
            enabled = true
            traceOwner = { call -> call.request.headers["X-User"]?.let { io.github.mprync.sendproof.core.TraceOwner.of("test", it, "") } }
            stores.forEach { dataStores += it }
        }
        routing {
            route("/counters") {
                sendproofPreview {
                    get("/{key}") {
                        (stores[0] as FakeStore).command("GET", CommandKind.READ)
                        call.respondText("""{"value":5}""", ContentType.Application.Json)
                    }
                    post("/{key}") {
                        val store = stores[0] as FakeStore
                        if (swallow) {
                            // The handler catches the refusal and returns 200.
                            runCatching { store.command("INCR", CommandKind.WRITE) }
                            call.respondText("""{"value":1}""", ContentType.Application.Json)
                        } else {
                            store.command("INCR", CommandKind.WRITE)
                            call.respondText("""{"value":1}""", ContentType.Application.Json)
                        }
                    }
                }
                sendproofPreview(enabled = false, stores = listOf("redis")) {
                    delete("/{key}") {
                        (stores[0] as FakeStore).command("DEL", CommandKind.WRITE)
                        call.respondText("", status = HttpStatusCode.NoContent)
                    }
                }
            }
            route("/documents") {
                sendproofPreview { post { call.respondText("{}", ContentType.Application.Json, HttpStatusCode.Created) } }
            }
        }
    }

    private suspend fun ApplicationTestBuilder.send(method: HttpMethod, path: String, vararg headers: Pair<String, String>): HttpResponse =
        createClient { followRedirects = false }.request(path) {
            this.method = method
            headers.forEach { header(it.first, it.second) }
            setBody("{}")
        }

    private val rollback = "Prefer" to "tx=rollback"

    private suspend fun HttpResponse.json(): JsonNode = Json.MAPPER.readTree(bodyAsText())

    @Test
    fun aCancelledHandlerStillAbortsEveryStoreAndRollsBackSql() = testApplication {
        val cleanup = Cleanup()
        application {
            install(Sendproof) {
                enabled = true
                provider = cleanup
                dataStores += cleanup
            }
            routing {
                route("/slow") {
                    sendproofPreview {
                        // A client that went away, a timeout or a cancelled parent job ends the handler like this.
                        post { throw kotlinx.coroutines.CancellationException("The client went away.") }
                    }
                }
            }
        }
        val response = runCatching { send(HttpMethod.Post, "/sendproof/_preview/slow", rollback) }.getOrNull()
        assertTrue(response == null || response.status != HttpStatusCode.OK, "A cancelled Preview is never confirmed")
        // Cleanup may finish just after the call unwinds.
        val deadline = System.nanoTime() + 5_000_000_000
        while (cleanup.steps.size < 4 && System.nanoTime() < deadline) {
            Thread.sleep(10)
        }
        assertEquals(listOf("store finish", "sql rollback", "store close", "sql close"), cleanup.steps.toList())
    }

    @Test
    fun aPreviewRunsWithoutASqlProviderWhenOnlyStoresAreHooked() = testApplication {
        val store = FakeStore()
        application { app(store) }
        val response = send(HttpMethod.Get, "/sendproof/_preview/counters/seeded", rollback)
        assertEquals(HttpStatusCode.OK, response.status)
        val envelope = response.json()
        assertTrue(envelope["rolledBack"].asBoolean())
        assertEquals("Db", envelope["logs"][0]["level"].asText())
        assertEquals("redis", envelope["logs"][0]["db"]["system"].asText())
    }

    @Test
    fun aBlockedPreviewAnswers409EvenWhenTheHandlerCaughtTheErrorAndReturned200() = testApplication {
        val store = FakeStore()
        application { app(store, swallow = true) }
        val response = send(HttpMethod.Post, "/sendproof/_preview/counters/x", rollback)
        assertEquals(HttpStatusCode.Conflict, response.status)
        assertNull(response.headers["Preference-Applied"])
        assertTrue(response.headers["Content-Type"]!!.startsWith("application/problem+json"))
        assertTrue(response.headers["Cache-Control"]!!.contains("no-store"))
        val problem = response.json()
        assertEquals("preview_unavailable", problem["code"].asText())
        assertEquals("redis", problem["store"].asText())
        assertEquals("INCR", problem["operation"].asText())
        assertEquals("Preview unavailable: this operation writes to Redis", problem["detail"].asText())
        assertFalse(problem["rolledBack"].asBoolean())
        assertFalse(problem.has("body"))
        assertTrue(store.written.isEmpty(), "No byte of the refused command reaches the store")
    }

    @Test
    fun theGuardDoesNothingOutsideAPreview() = testApplication {
        val store = FakeStore()
        application { app(store) }
        val response = send(HttpMethod.Post, "/counters/x")
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(listOf("INCR"), store.written)
    }

    @Test
    fun discoveryListsStoresUnavailableOperationsAndTheBinding() = testApplication {
        application { app(FakeStore(), FakeTransactional()) }
        val capabilities = send(HttpMethod.Get, "/sendproof/_api/capabilities").json()
        assertEquals(listOf("redis", "mongodb"), capabilities["dataStores"].map { it["system"].asText() })
        assertEquals("guard", capabilities["dataStores"][0]["mode"].asText())
        assertEquals("preview", capabilities["dataStores"][1]["mode"].asText())
        val operations = capabilities["previewOperations"].map { it["method"].asText() + " " + it["path"].asText() }
        assertFalse("DELETE /counters/{key}" in operations)
        assertTrue("GET /counters/{key}" in operations)
        val marked = capabilities["previewUnavailable"][0]
        assertEquals("DELETE", marked["method"].asText())
        assertEquals("/counters/{key}", marked["path"].asText())
        assertEquals("Preview unavailable: this operation writes to Redis", marked["reason"].asText())
        assertEquals(listOf("redis"), marked["stores"].map { it.asText() })
        assertTrue(capabilities["database"].isNull)
    }

    @Test
    fun anUnavailableOperationNeverRunsItsHandlerInAPreview() = testApplication {
        val store = FakeStore()
        application { app(store) }
        val response = send(HttpMethod.Delete, "/sendproof/_preview/counters/x", rollback)
        assertEquals(HttpStatusCode.Conflict, response.status)
        assertNull(response.headers["Preference-Applied"])
        assertTrue(store.written.isEmpty())
        // Ordinary Send still works.
        assertEquals(HttpStatusCode.NoContent, send(HttpMethod.Delete, "/counters/x").status)
        assertEquals(listOf("DEL"), store.written)
    }

    @Test
    fun aTransactionalStoreJoinsThePreviewAndItsChangesAreReported() = testApplication {
        val store = FakeTransactional()
        application { app(FakeStore(), store) }
        val response = send(HttpMethod.Post, "/sendproof/_preview/documents", rollback)
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(1, store.finished)
        val change = response.json()["changes"][0]
        assertEquals("mongodb", change["store"].asText())
        assertEquals("documents", change["table"].asText())
    }

    @Test
    fun theMarkNeedsAReasonOrTheStoresItWrites() {
        val failure = assertFailsWith<IllegalArgumentException> {
            testApplication {
                application {
                    install(Sendproof) { enabled = true }
                    routing { route("/x") { sendproofPreview(enabled = false) { get { } } } }
                }
                send(HttpMethod.Get, "/x")
            }
        }
        assertTrue(failure.message!!.contains("needs a reason"))
        assertFailsWith<PreviewWriteBlockedException> { throw PreviewWriteBlockedException("redis", "SET", "x") }
    }
}
