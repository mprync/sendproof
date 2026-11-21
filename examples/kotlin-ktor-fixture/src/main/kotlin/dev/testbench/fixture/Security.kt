package dev.testbench.fixture

import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.createRouteScopedPlugin
import io.ktor.server.response.respond
import io.ktor.util.AttributeKey

/** The signed-in account for a request, from its session cookie. */
fun ApplicationCall.account(accounts: Accounts): Account? = accounts.session(request.cookies[Accounts.COOKIE])

class SecurityConfig {
    var accounts: Accounts? = null
}

/**
 * Route-scoped authorization: 401 for anonymous callers, 403 when a viewer writes. It runs before the handler, in the
 * plugin phase, so Test Bench begins a preview only for calls that are allowed.
 */
val Secured = createRouteScopedPlugin("FixtureSecured", ::SecurityConfig) {
    val accounts = checkNotNull(pluginConfig.accounts) { "accounts" }
    onCall { call ->
        val account = call.account(accounts)
        val reading = call.request.local.method == HttpMethod.Get
        when {
            account == null -> call.respond(HttpStatusCode.Unauthorized)
            !reading && account.role != "admin" -> call.respond(HttpStatusCode.Forbidden)
        }
    }
}
