plugins { `java-library` }

description = "Spring Boot (Servlet/MVC) integration: workbench, preview and observed send, springdoc discovery."

dependencies {
    val bom = platform(rootProject.libs.spring.boot.bom)
    implementation(bom)
    testImplementation(bom)
    annotationProcessor(bom)
    annotationProcessor("org.springframework.boot:spring-boot-configuration-processor")

    api(project(":sendproof-core"))
    // The packaged workbench UI. Applications get it transitively.
    api(project(":sendproof-ui"))
    api(project(":sendproof-logback"))
    // Data store hooks. Their client libraries are compile-only there: the application brings the ones it uses.
    api(project(":sendproof-mongodb"))
    api(project(":sendproof-redis"))
    api(project(":sendproof-dynamodb"))
    api(project(":sendproof-cassandra"))
    api(project(":sendproof-elasticsearch"))
    api("org.springframework.boot:spring-boot-autoconfigure")
    api("org.springframework:spring-webmvc")

    compileOnly("jakarta.servlet:jakarta.servlet-api")
    compileOnly("org.springframework.security:spring-security-core")
    compileOnly("org.springframework.security:spring-security-web")
    compileOnly("ch.qos.logback:logback-classic")
    compileOnly("org.springframework.data:spring-data-mongodb")
    compileOnly("org.springframework.data:spring-data-redis")
    compileOnly(rootProject.libs.mongodb.sync)
    compileOnly(rootProject.libs.cassandra.driver)
    compileOnly(rootProject.libs.elasticsearch.java)
    compileOnly(rootProject.libs.opensearch.java)
    compileOnly(rootProject.libs.springdoc.webmvc.api)

    testImplementation("org.springframework.boot:spring-boot-starter-web")
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.boot:spring-boot-starter-data-mongodb")
    testImplementation("org.springframework.boot:spring-boot-starter-data-redis")
    testImplementation(rootProject.libs.springdoc.webmvc.api)
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
