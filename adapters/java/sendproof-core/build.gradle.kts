description = "Framework-neutral Sendproof protocol core: capture, preview orchestration, traces and workbench assets."

dependencies {
    // Versions come from Jackson's own BOM so consumers (including Kotlin/Ktor builds) are not tied to Spring's.
    api(platform(rootProject.libs.jackson.bom))
    api("com.fasterxml.jackson.core:jackson-databind")
    api(rootProject.libs.slf4j.api)
    implementation("com.fasterxml.jackson.datatype:jackson-datatype-jsr310")

    testImplementation(platform(rootProject.libs.spring.boot.bom))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation("org.assertj:assertj-core")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testRuntimeOnly("org.slf4j:slf4j-simple")
}

// The data-store classification tables are embedded unchanged from spec/data-stores/. StoreTablesTest fails when the
// copies in src/main/resources differ from the spec; this task refreshes them.
val syncStoreTables by tasks.registering(Copy::class) {
    description = "Copies spec/data-stores/{redis,mongodb,dynamodb}.json into the embedded resources."
    from(rootDir.resolve("../../spec/data-stores")) { include("redis.json", "mongodb.json", "dynamodb.json") }
    into(layout.projectDirectory.dir("src/main/resources/io/github/mprync/sendproof/core/stores"))
}

tasks.test {
    systemProperty("sendproof.spec.dir", rootDir.resolve("../../spec").canonicalPath)
}
