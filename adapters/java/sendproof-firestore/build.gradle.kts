description = "Firestore write guard: a gRPC client interceptor for google-cloud-firestore that refuses writes during a Preview and logs calls."

dependencies {
    api(project(":sendproof-core"))
    // The Firestore client, and gRPC with it, are the host's choice and version.
    compileOnly(rootProject.libs.google.firestore)

    testImplementation(rootProject.libs.google.firestore)
    testImplementation(platform(rootProject.libs.spring.boot.bom))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation("org.assertj:assertj-core")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testRuntimeOnly("org.slf4j:slf4j-simple")
}
