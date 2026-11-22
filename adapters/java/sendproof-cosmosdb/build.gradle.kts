description = "Cosmos DB write guard: guarded wrappers over the azure-cosmos containers that refuse writes during a Preview and log operations."

dependencies {
    api(project(":sendproof-core"))
    // The SDK is the host's choice and version.
    compileOnly(rootProject.libs.azure.cosmos)

    testImplementation(rootProject.libs.azure.cosmos)
    testImplementation(platform(rootProject.libs.spring.boot.bom))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation("org.assertj:assertj-core")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testRuntimeOnly("org.slf4j:slf4j-simple")
}
