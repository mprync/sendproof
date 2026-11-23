plugins {
    alias(libs.plugins.kotlin.jvm)
    application
}

description = "Conformance fixture: a Ktor + JDBC + H2 app that exercises the Kotlin/Ktor binding over real HTTP."

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

application {
    mainClass.set("io.github.mprync.sendproof.fixture.MainKt")
    applicationName = "ktor-fixture"
}

dependencies {
    implementation(platform(libs.ktor.bom))
    implementation(platform(libs.jackson.bom))
    implementation(project(":sendproof-ktor"))
    implementation("io.ktor:ktor-server-cio")
    implementation("io.ktor:ktor-server-content-negotiation")
    implementation("io.ktor:ktor-serialization-jackson")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin")
    implementation("com.zaxxer:HikariCP:6.3.0")
    // The data stores of spec/conformance/fixture.md, each used only when the runner passes its variables.
    implementation(libs.mongodb.kotlin)
    implementation("redis.clients:jedis:5.2.0")
    implementation(platform(libs.awssdk.bom))
    implementation("software.amazon.awssdk:dynamodb")
    // Batch two (Cassandra, OpenSearch), each used only when the runner passes its variables.
    implementation(libs.cassandra.driver)
    implementation(libs.opensearch.java)
    implementation(libs.httpclient5)
    runtimeOnly("com.h2database:h2:2.3.232")
    runtimeOnly("ch.qos.logback:logback-classic:1.5.18")

    testImplementation("org.jetbrains.kotlin:kotlin-test-junit5")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
