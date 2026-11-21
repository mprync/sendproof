package dev.testbench.fixture

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** An account the fixture can sign in. */
data class Account(val email: String, val name: String, val role: String)

/** The fixture's accounts and their cookie sessions (opaque tokens held in memory). */
class Accounts {
    private val sessions = ConcurrentHashMap<String, Account>()

    val all: List<Account> = listOf(
        Account("admin@example.test", "Fixture Admin", "admin"),
        Account("viewer@example.test", "Fixture Viewer", "viewer"),
    )

    fun byEmail(email: String): Account? = all.firstOrNull { it.email.equals(email, ignoreCase = true) }

    fun verify(email: String?, password: String?): Account? =
        if (password == "bench-fixture" && email != null) byEmail(email) else null

    /** Starts a new session and returns its token. Earlier sessions stay valid. */
    fun open(account: Account): String = UUID.randomUUID().toString().also { sessions[it] = account }

    fun session(token: String?): Account? = token?.let { sessions[it] }

    companion object {
        const val COOKIE = "fixture_session"
    }
}
