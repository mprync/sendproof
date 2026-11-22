plugins {
    alias(libs.plugins.kotlin.jvm)
}

description = "Ktor integration: workbench, in-process preview dispatch, observed send, JDBC enrollment."

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        allWarningsAsErrors.set(false)
    }
}

dependencies {
    implementation(platform(libs.ktor.bom))
    api(project(":sendproof-core"))
    api(project(":sendproof-jdbc"))
    api(project(":sendproof-ui"))
    api(project(":sendproof-logback"))
    // Data store hooks. Their client libraries are compile-only there: the application brings the ones it uses.
    api(project(":sendproof-mongodb"))
    api(project(":sendproof-redis"))
    api(project(":sendproof-dynamodb"))
    api(project(":sendproof-cassandra"))
    api(project(":sendproof-elasticsearch"))
    compileOnly(libs.mongodb.kotlin)
    api("io.ktor:ktor-server-core")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core")

    testImplementation("io.ktor:ktor-server-test-host")
    testImplementation("io.ktor:ktor-client-content-negotiation")
    testImplementation("com.h2database:h2:2.3.232")
    testImplementation("ch.qos.logback:logback-classic:1.5.18")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit5")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
}

// Kotlin sources are not processed by the Javadoc tool, so the Javadoc jar Maven Central requires would be empty.
// It carries a pointer to the real documentation instead; the Kotlin sources ship in the -sources jar.
val kotlinDocsPlaceholder by tasks.registering {
    val readme = layout.buildDirectory.file("javadoc-placeholder/README.md")
    outputs.file(readme)
    doLast {
        readme.get().asFile.apply {
            parentFile.mkdirs()
            writeText(
                "# sendproof-ktor\n\nThis module is written in Kotlin, so there is no generated Javadoc.\n" +
                    "Read the KDoc comments in the `-sources` jar, or the module README in the repository.\n",
            )
        }
    }
}

tasks.named<Jar>("javadocJar") {
    from(kotlinDocsPlaceholder)
}
