description = "The Test Bench workbench UI bundle, embedded as classpath resources under testbench-ui/."

val repoRoot = rootDir.resolve("../..").canonicalFile
val nodeExecutable = (findProperty("nodeExecutable") as String?) ?: "node"
val bundleDir = layout.buildDirectory.dir("ui-bundle")

// The UI is never copied or forked into this module. The shared packer produces manifest.json plus the original
// files, and this module only embeds that output.
val packUi by tasks.registering(Exec::class) {
    group = "build"
    description = "Packs the shared UI with tools/pack-ui.mjs."
    inputs.dir(repoRoot.resolve("ui")).withPropertyName("ui")
    inputs.file(repoRoot.resolve("tools/pack-ui.mjs")).withPropertyName("packer")
    inputs.property("version", project.version.toString())
    outputs.dir(bundleDir)
    workingDir = repoRoot
    doFirst { delete(bundleDir) }
    commandLine(nodeExecutable, "tools/pack-ui.mjs", "--version", project.version.toString(),
        "--out", bundleDir.get().asFile.absolutePath)
}

tasks.processResources {
    from(packUi) { into("testbench-ui") }
}
