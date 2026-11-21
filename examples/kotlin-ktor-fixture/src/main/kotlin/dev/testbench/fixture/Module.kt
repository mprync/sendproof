package dev.testbench.fixture

import dev.testbench.core.Capabilities
import dev.testbench.core.PreviewChange
import dev.testbench.core.PreviewObservation
import dev.testbench.core.PreviewProvider
import dev.testbench.core.PreviewSession
import dev.testbench.core.TestBenchCapture
import dev.testbench.core.TraceOwner
import dev.testbench.jdbc.JdbcPreviewProvider
import dev.testbench.ktor.TestBench
import dev.testbench.ktor.testBenchPreview
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.Cookie
import io.ktor.serialization.jackson.jackson
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import io.ktor.server.routing.routing

/** Wraps the real provider and reports an injected failure after it has rolled back for real. */
private class FailingRollbackProvider(private val delegate: PreviewProvider) : PreviewProvider by delegate {
    override fun begin(): PreviewSession {
        val session = delegate.begin()
        return object : PreviewSession {
            override fun changes(): List<PreviewChange> = session.changes()

            override fun rollback() {
                session.rollback()
                throw IllegalStateException("Injected rollback failure.")
            }

            override fun close() = session.close()
        }
    }

    override fun beginObservation(): PreviewObservation? = delegate.beginObservation()
}

fun Application.fixtureModule(scenario: Scenario) {
    val accounts = Accounts()
    val database = Database()
    val capture = TestBenchCapture()
    val items = Items(database, capture)
    val base = scenario.pathBase

    install(ContentNegotiation) { jackson() }
    install(TestBench) {
        enabled = scenario.enabled
        pathBase = base
        environment = "Development"
        apiName = "Test Bench Conformance"
        openApiUrl = "/openapi.json"
        authProviders += Capabilities.AuthProvider("Fixture password", "cookie", "/auth/sign-in")
        authProviders += Capabilities.AuthProvider("Fixture personas", "personas", "/auth/personas")
        traceRetention = java.time.Duration.ofSeconds(5)
        if (scenario.hasProvider) {
            val real = JdbcPreviewProvider(database.dataSource) { "In-memory H2" }
            provider = if (scenario.failsRollback) FailingRollbackProvider(real) else real
        }
        identity = { call -> call.account(accounts)?.let { Capabilities.Identity(it.name, it.role) } }
        traceOwner = { call -> call.account(accounts)?.let { TraceOwner.of("cookie", it.email, base) } }
    }

    routing {
        route(base) {
            get("/ready") { call.respondText("ok") }
            get("/openapi.json") {
                val spec = Application::class.java.classLoader.getResource("openapi.json")!!.readText()
                call.respondText(spec, io.ktor.http.ContentType.Application.Json)
            }
            authRoutes(accounts, base)
            itemRoutes(accounts, items, base)
        }
    }
}

private fun io.ktor.server.routing.Route.authRoutes(accounts: Accounts, base: String) {
    suspend fun start(call: ApplicationCall, account: Account) {
        call.response.header(
            HttpHeaders.SetCookie,
            "${Accounts.COOKIE}=${accounts.open(account)}; Path=${base.ifEmpty { "/" }}; HttpOnly; SameSite=Lax",
        )
        call.respond(account)
    }
    route("/auth") {
        post("/sign-in") {
            val body = runCatching { call.receive<Map<String, Any?>>() }.getOrNull().orEmpty()
            val account = accounts.verify(body["email"] as? String, body["password"] as? String)
            if (account == null) call.respond(HttpStatusCode.Unauthorized) else start(call, account)
        }
        get("/personas") {
            if (call.account(accounts) == null) call.respond(HttpStatusCode.Unauthorized) else call.respond(accounts.all)
        }
        post("/personas/{email}") {
            if (call.account(accounts) == null) return@post call.respond(HttpStatusCode.Unauthorized)
            val persona = accounts.byEmail(call.parameters["email"].orEmpty())
            if (persona == null) call.respond(HttpStatusCode.NotFound) else start(call, persona)
        }
    }
}

private suspend fun ApplicationCall.json(): Map<String, Any?>? = runCatching { receive<Map<String, Any?>>() }.getOrNull()

private fun io.ktor.server.routing.Route.itemRoutes(accounts: Accounts, items: Items, base: String) {
    route("/items") {
        install(Secured) { this.accounts = accounts }

        get("/{id}") {
            val item = items.find(call.parameters["id"]!!)
            if (item == null) call.respond(HttpStatusCode.NotFound) else call.respond(item)
        }

        testBenchPreview {
            post {
                val body = call.json()
                val id = (body?.get("id") as? String)?.takeIf { it.isNotBlank() }
                val name = (body?.get("name") as? String)?.takeIf { it.isNotBlank() }
                if (id == null || name == null) {
                    return@post call.respond(HttpStatusCode.BadRequest, mapOf("error" to "id and name are required"))
                }
                try {
                    call.respond(HttpStatusCode.Created, items.create(id, name))
                } catch (duplicate: DuplicateItem) {
                    call.respond(HttpStatusCode.Conflict, mapOf("error" to duplicate.message))
                }
            }
            patch("/{id}") {
                val name = (call.json()?.get("name") as? String)?.takeIf { it.isNotBlank() }
                    ?: return@patch call.respond(HttpStatusCode.BadRequest, mapOf("error" to "name is required"))
                call.request.queryParameters["tag"]?.let { call.response.header("X-Fixture-Tag", it) }
                val item = items.rename(call.parameters["id"]!!, name)
                if (item == null) call.respond(HttpStatusCode.NotFound) else call.respond(item)
            }
            delete("/{id}") {
                items.delete(call.parameters["id"]!!)
                call.respond(HttpStatusCode.NoContent)
            }
            post("/{id}/fail") {
                if (call.request.queryParameters["mode"] == "exception") error("Unhandled failure")
                try {
                    items.insertThenFail(call.parameters["id"]!!)
                } catch (failure: HandledFailure) {
                    call.respond(HttpStatusCode.Conflict, mapOf("error" to failure.message))
                }
            }
            post("/{id}/large") {
                items.insertPlain(call.parameters["id"]!!, "large")
                call.respond(mapOf("data" to "x".repeat(1_500_000)))
            }
            post("/{id}/redirect") {
                call.response.header(HttpHeaders.Location, "$base/items/${call.parameters["id"]}")
                call.response.cookies.append(Cookie("fixture_inner", "1"))
                call.respond(HttpStatusCode.Found)
            }
            post("/{id}/capture") {
                call.respond(mapOf("created" to items.capture(call.parameters["id"]!!)))
            }
        }

        // Deliberately not marked: Preview must refuse it, ordinary Send must still work.
        post("/{id}/ordinary") {
            call.respond(HttpStatusCode.Created, items.insertPlain(call.parameters["id"]!!, "ordinary"))
        }
    }
}
