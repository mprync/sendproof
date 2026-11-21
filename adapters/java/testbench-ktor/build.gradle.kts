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
    api(project(":testbench-core"))
    api(project(":testbench-jdbc"))
    api(project(":testbench-ui"))
    api(project(":testbench-logback"))
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
