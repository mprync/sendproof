description = "Cassandra write guard: a guarded DataStax Java driver 4 session (also for Spring Data Cassandra) that refuses writes during a Preview and logs statements."

dependencies {
    api(project(":sendproof-core"))
    // The driver is the host's choice and version.
    compileOnly(rootProject.libs.cassandra.driver)

    testImplementation(rootProject.libs.cassandra.driver)
    testImplementation(platform(rootProject.libs.spring.boot.bom))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation("org.assertj:assertj-core")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testRuntimeOnly("org.slf4j:slf4j-simple")
}
