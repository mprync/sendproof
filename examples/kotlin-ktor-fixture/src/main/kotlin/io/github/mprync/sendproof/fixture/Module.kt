package io.github.mprync.sendproof.fixture

import io.github.mprync.sendproof.core.Capabilities
import io.github.mprync.sendproof.core.PreviewChange
import io.github.mprync.sendproof.core.PreviewObservation
import io.github.mprync.sendproof.core.PreviewProvider
import io.github.mprync.sendproof.core.PreviewSession
import io.github.mprync.sendproof.core.SendproofCapture
import io.github.mprync.sendproof.core.TraceOwner
import io.github.mprync.sendproof.jdbc.JdbcPreviewProvider
import io.github.mprync.sendproof.ktor.Sendproof
import io.github.mprync.sendproof.ktor.sendproofPreview
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

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
    val capture = SendproofCapture()
    val items = Items(database, capture)
    val stores = if (scenario.enabled) Stores() else Stores.none()
    val base = scenario.pathBase

    install(ContentNegotiation) { jackson() }
    install(Sendproof) {
        enabled = scenario.enabled
        pathBase = base
        environment = "Development"
        apiName = "Sendproof Conformance"
        openApiUrl = "/openapi.json"
        authProviders += Capabilities.AuthProvider("Fixture password", "cookie", "/auth/sign-in")
        authProviders += Capabilities.AuthProvider("Fixture personas", "personas", "/auth/personas")
        traceRetention = java.time.Duration.ofSeconds(5)
        dataStores += stores.all
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
            itemRoutes(accounts, items, base, stores)
            accountRoutes(accounts, items)
            stores.mongo?.let { documentRoutes(accounts, it) }
            stores.redis?.let { counterRoutes(accounts, it) }
            stores.dynamo?.let { orderRoutes(accounts, it) }
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

private fun io.ktor.server.routing.Route.itemRoutes(accounts: Accounts, items: Items, base: String, stores: Stores) {
    route("/items") {
        install(Secured) { this.accounts = accounts }

        get("/{id}") {
            val item = items.find(call.parameters["id"]!!)
            if (item == null) call.respond(HttpStatusCode.NotFound) else call.respond(item)
        }

        sendproofPreview {
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
            // The shared raw-commit rule: a handler that ends the Preview transaction by hand.
            post("/{id}/commit") {
                val name = (call.json()?.get("name") as? String)?.takeIf { it.isNotBlank() }
                    ?: return@post call.respond(HttpStatusCode.BadRequest, mapOf("error" to "name is required"))
                call.respond(HttpStatusCode.Created, items.insertThenCommit(call.parameters["id"]!!, name))
            }
            // The mixed route: a SQL insert, then a write to a guarded store, which must roll back or block together.
            post("/{id}/remember") {
                val id = call.parameters["id"]!!
                val name = (call.json()?.get("name") as? String)?.takeIf { it.isNotBlank() }
                    ?: return@post call.respond(HttpStatusCode.BadRequest, mapOf("error" to "name is required"))
                val item = items.insertPlain(id, name)
                when (call.request.queryParameters["store"]) {
                    "redis" -> withContext(Dispatchers.IO) { stores.redis!!.jedis.incr(stores.redis.key("item-$id")) }
                    else -> touchOrder(stores.dynamo!!, "item-$id")
                }
                call.respond(HttpStatusCode.Created, item)
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

/** The shared secret-column rule: accounts are stored with `password_hash` as the literal `hashed:<password>`. */
private fun io.ktor.server.routing.Route.accountRoutes(accounts: Accounts, items: Items) {
    route("/accounts") {
        install(Secured) { this.accounts = accounts }
        get("/{id}") {
            val account = items.findAccount(call.parameters["id"]!!)
            if (account == null) call.respond(HttpStatusCode.NotFound) else call.respond(account)
        }
        sendproofPreview {
            post {
                val body = call.json()
                val id = body?.get("id") as? String
                val email = body?.get("email") as? String
                val password = body?.get("password") as? String
                if (id == null || email == null || password == null) {
                    return@post call.respond(HttpStatusCode.BadRequest, mapOf("error" to "id, email and password are required"))
                }
                call.respond(HttpStatusCode.Created, items.createAccount(id, email, password))
            }
        }
    }
}
