package dev.testbench.ktor

import com.fasterxml.jackson.databind.JsonNode
import dev.testbench.core.Json
import dev.testbench.core.TestBenchCapture
import dev.testbench.core.TraceOwner
import dev.testbench.jdbc.JdbcPreviewProvider
import dev.testbench.jdbc.PreviewDataSource
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.call
import io.ktor.server.application.createRouteScopedPlugin
import io.ktor.server.application.install
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import java.util.UUID
import org.h2.jdbcx.JdbcDataSource
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** A deny switch standing in for the host's authorization: it runs before the handler, like a real plugin. */
private val Deny = createRouteScopedPlugin("Deny") {
    onCall { call ->
        if (call.request.headers["X-Deny"] != null) call.respond(HttpStatusCode.Forbidden)
    }
}

class TestBenchPluginTest {
    private val raw = JdbcDataSource().apply { setURL("jdbc:h2:mem:${UUID.randomUUID()};DB_CLOSE_DELAY=-1") }
    private val data = PreviewDataSource(raw) { true }
    private val capture = TestBenchCapture()

    init {
        raw.connection.use { it.createStatement().use { s -> s.execute("create table items (id varchar(40) primary key, name varchar(100))") } }
    }

    private fun count(): Int = raw.connection.use { c ->
        c.createStatement().use { s -> s.executeQuery("select count(*) from items").use { it.next(); it.getInt(1) } }
    }

    private fun Application.app(enabled: Boolean = true) {
        install(TestBench) {
            this.enabled = enabled
            provider = JdbcPreviewProvider(data) { "Test DB" }
            traceOwner = { call -> call.request.headers["X-User"]?.let { TraceOwner.of("test", it, "") } }
            traceRetention = java.time.Duration.ofSeconds(5)
        }
        routing {
            route("/items") {
                install(Deny)
                testBenchPreview {
                    post {
                        val id = call.request.queryParameters["id"] ?: "a"
                        data.connection.use { c ->
                            c.prepareStatement("insert into items (id, name) values (?, ?)").use { s ->
                                s.setString(1, id)
                                s.setString(2, "Bolt")
                                s.executeUpdate()
                            }
                            c.commit()
                        }
                        capture.tryRecordLog("Information", "created:$id")
                        call.respondText("""{"id":"$id"}""", io.ktor.http.ContentType.Application.Json, HttpStatusCode.Created)
                    }
                    post("/boom") { error("unhandled") }
                }
                post("/unmarked") { call.respondText("ordinary") }
            }
            get("/other") { call.respondText("x") }
        }
    }

    private suspend fun ApplicationTestBuilder.send(
        method: HttpMethod, path: String, vararg headers: Pair<String, String>,
    ): HttpResponse = createClient { followRedirects = false }.request(path) {
        this.method = method
        headers.forEach { header(it.first, it.second) }
        setBody("{}")
    }

    private val rollback = "Prefer" to "tx=rollback"

    private suspend fun HttpResponse.json(): JsonNode = Json.MAPPER.readTree(bodyAsText())

    @Test
    fun aMarkedOperationIsConfirmedCapturedAndRolledBack() = testApplication {
        application { app() }
        val response = send(HttpMethod.Post, "/bench/_preview/items?id=p1", rollback)
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("tx=rollback", response.headers["Preference-Applied"])
        assertTrue(response.headers["Cache-Control"]!!.contains("no-store"))
        assertNull(response.headers["Set-Cookie"])
        val envelope = response.json()
        assertTrue(envelope["rolledBack"].asBoolean())
        assertEquals(201, envelope["status"].asInt())
        assertEquals("p1", envelope["body"]["id"].asText())
        assertEquals("insert", envelope["changes"][0]["operation"].asText())
        assertEquals("p1", envelope["changes"][0]["key"]["id"].asText())
        assertTrue(envelope["logs"].any { it.has("sql") })
        assertEquals(0, count())
    }

    @Test
    fun invalidTransportAndUnmarkedTargetsNeverExecute() = testApplication {
        application { app() }
        assertEquals(400, send(HttpMethod.Post, "/bench/_preview/items").status.value)
        assertEquals(400, send(HttpMethod.Post, "/bench/_preview/items", "Prefer" to "trace, tx=rollback").status.value)
        assertEquals(400, send(HttpMethod.Post, "/items", rollback).status.value)
        assertEquals(405, send(HttpMethod.Head, "/bench/_preview/items", rollback).status.value)
        assertEquals(400, send(HttpMethod.Post, "/bench/_preview//items", rollback).status.value)
        assertEquals(400, send(HttpMethod.Post, "/bench/_preview/bench/_api/capabilities", rollback).status.value)
        assertEquals(403, send(HttpMethod.Post, "/bench/_preview/items", rollback, "Origin" to "https://elsewhere.example.test").status.value)
        assertEquals(409, send(HttpMethod.Post, "/bench/_preview/items/unmarked", rollback).status.value)
        assertEquals(404, send(HttpMethod.Post, "/bench/_preview/missing", rollback).status.value)
        assertEquals(0, count())
    }

    @Test
    fun hostAuthorizationRunsBeforeThePreviewBegins() = testApplication {
        application { app() }
        val response = send(HttpMethod.Post, "/bench/_preview/items", rollback, "X-Deny" to "1")
        assertEquals(403, response.status.value)
        assertNull(response.headers["Preference-Applied"])
        assertEquals(0, count())
    }

    @Test
    fun anUnhandledExceptionRollsBackButIsNeverConfirmed() = testApplication {
        application { app() }
        val response = send(HttpMethod.Post, "/bench/_preview/items/boom", rollback)
        assertEquals(500, response.status.value)
        assertNull(response.headers["Preference-Applied"])
        assertFalse(response.bodyAsText().contains("rolledBack"))
    }

    @Test
    fun anObservedSendKeepsItsCommitAndPublishesAnOwnerOnlyTrace() = testApplication {
        application { app() }
        val send = send(HttpMethod.Post, "/items?id=t1", "Prefer" to "trace", "X-User" to "alice")
        assertEquals(HttpStatusCode.Created, send.status)
        assertEquals(1, count())
        val id = assertNotNull(send.headers["X-TestBench-Trace"])
        val owned = send(HttpMethod.Get, "/bench/_api/traces/$id", "X-User" to "alice")
        assertEquals(200, owned.status.value)
        val trace = owned.json()
        assertEquals("insert", trace["changes"][0]["operation"].asText())
        assertTrue(trace["logs"].any { it["message"].asText() == "created:t1" })
        assertEquals(404, send(HttpMethod.Get, "/bench/_api/traces/$id", "X-User" to "bob").status.value)
        assertEquals(404, send(HttpMethod.Get, "/bench/_api/traces/$id").status.value)
        // No authenticated subject, an unmarked route, and a cross-origin send are never traced.
        assertNull(send(HttpMethod.Post, "/items?id=t2", "Prefer" to "trace").headers["X-TestBench-Trace"])
        assertNull(send(HttpMethod.Post, "/items/unmarked", "Prefer" to "trace", "X-User" to "alice").headers["X-TestBench-Trace"])
    }

    @Test
    fun discoveryListsMarkedOperationsAndTheWorkbenchIsServed() = testApplication {
        application { app() }
        val capabilities = send(HttpMethod.Get, "/bench/_api/capabilities").json()
        assertEquals("Test DB", capabilities["database"].asText())
        val operations = capabilities["previewOperations"].map { it["method"].asText() + " " + it["path"].asText() }
        assertEquals(listOf("POST /items", "POST /items/boom"), operations)
        val index = send(HttpMethod.Get, "/bench/")
        assertEquals(200, index.status.value)
        assertEquals("nosniff", index.headers["X-Content-Type-Options"])
        assertEquals(302, send(HttpMethod.Get, "/bench").status.value)
        assertEquals(404, send(HttpMethod.Get, "/bench/nope.js").status.value)
    }

    @Test
    fun whenDisabledNothingIsMounted() = testApplication {
        application { app(enabled = false) }
        assertEquals(404, send(HttpMethod.Get, "/bench/_api/capabilities").status.value)
        assertEquals(404, send(HttpMethod.Post, "/bench/_preview/items", rollback).status.value)
        assertEquals(HttpStatusCode.Created, send(HttpMethod.Post, "/items?id=ok").status)
    }
}
