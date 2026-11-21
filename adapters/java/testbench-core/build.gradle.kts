description = "Framework-neutral Test Bench protocol core: capture, preview orchestration, traces and workbench assets."

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
