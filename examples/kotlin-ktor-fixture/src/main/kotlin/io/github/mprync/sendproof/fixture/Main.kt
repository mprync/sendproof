package io.github.mprync.sendproof.fixture

import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer

/** Starts the conformance fixture. The runner supplies PORT, BENCH_PATH_BASE and BENCH_SCENARIO. */
fun main() {
    val port = System.getenv("PORT")?.toInt() ?: 8080
    embeddedServer(CIO, host = "127.0.0.1", port = port) { fixtureModule(Scenario.fromEnvironment()) }.start(wait = true)
}
