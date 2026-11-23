description = "MongoDB integration: Preview inside a rolled-back transaction, the write guard, the escape tripwire and document change capture."

dependencies {
    api(project(":sendproof-core"))
    // The driver is the host's choice and version: it is only needed at compile time, and each entry point names the
    // flavor it needs (synchronous or reactive streams).
    compileOnly(rootProject.libs.mongodb.sync)
    compileOnly(rootProject.libs.mongodb.reactivestreams)
    compileOnly(platform(rootProject.libs.spring.boot.bom))
    compileOnly("io.projectreactor:reactor-core")

    testImplementation(platform(rootProject.libs.spring.boot.bom))
    testImplementation(rootProject.libs.mongodb.sync)
    testImplementation(rootProject.libs.mongodb.reactivestreams)
    testImplementation("io.projectreactor:reactor-core")
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation("org.assertj:assertj-core")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testRuntimeOnly("org.slf4j:slf4j-simple")
}
