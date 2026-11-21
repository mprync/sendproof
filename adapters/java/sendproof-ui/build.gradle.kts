description = "The Sendproof workbench UI bundle, embedded as classpath resources under sendproof-ui/."

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
    from(packUi) { into("sendproof-ui") }
}

// This module has no Java or Kotlin code: the original UI source files are the "sources", and there is no API to
// document. Maven Central still requires both jars, so the sources jar carries the bundle and the Javadoc jar a note.
val docsPlaceholder by tasks.registering {
    val readme = layout.buildDirectory.file("javadoc-placeholder/README.md")
    outputs.file(readme)
    doLast {
        readme.get().asFile.apply {
            parentFile.mkdirs()
            writeText("# sendproof-ui\n\nThis module only embeds the Sendproof workbench UI as classpath resources under `sendproof-ui/`.\nIt has no Java API, so there is no generated Javadoc.\n")
        }
    }
}

tasks.named<Jar>("sourcesJar") {
    from(packUi) { into("sendproof-ui") }
}

tasks.named<Jar>("javadocJar") {
    from(docsPlaceholder)
}
