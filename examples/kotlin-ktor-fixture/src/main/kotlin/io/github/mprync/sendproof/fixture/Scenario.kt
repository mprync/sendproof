package io.github.mprync.sendproof.fixture

/** What the runner asks the fixture to do: the standard app, or one of the alternate configurations. */
data class Scenario(val name: String, val pathBase: String) {
    val enabled: Boolean get() = name != "disabled"
    val hasProvider: Boolean get() = name != "no-provider"
    val failsRollback: Boolean get() = name == "rollback-failure"

    companion object {
        fun fromEnvironment(): Scenario =
            Scenario(System.getenv("BENCH_SCENARIO") ?: "standard", System.getenv("BENCH_PATH_BASE") ?: "")
    }
}
