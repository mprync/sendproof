description = "Elasticsearch and OpenSearch write guard: a guarded elasticsearch-java or opensearch-java transport that refuses writes during a Preview and logs requests."

dependencies {
    api(project(":sendproof-core"))
    // The clients are the host's choice and version: each store class needs only its own.
    compileOnly(rootProject.libs.elasticsearch.java)
    compileOnly(rootProject.libs.opensearch.java)

    testImplementation(rootProject.libs.elasticsearch.java)
    testImplementation(rootProject.libs.opensearch.java)
    testImplementation(rootProject.libs.httpclient5)
    testImplementation("org.elasticsearch.client:elasticsearch-rest-client:${rootProject.libs.versions.elasticsearchJava.get()}")
    testImplementation(platform(rootProject.libs.spring.boot.bom))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation("org.assertj:assertj-core")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testRuntimeOnly("org.slf4j:slf4j-simple")
}
