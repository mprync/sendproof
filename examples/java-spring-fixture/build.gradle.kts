plugins {
    alias(libs.plugins.spring.boot)
}

description = "Conformance fixture: a Spring Boot + JPA + H2 app that exercises the Java binding over real HTTP."

dependencies {
    implementation(platform(libs.spring.boot.bom))
    implementation(project(":testbench-jpa"))
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation(libs.springdoc.webmvc.api)
    runtimeOnly("com.h2database:h2")
}

tasks.bootJar {
    archiveFileName.set("test-bench-java-fixture.jar")
}
