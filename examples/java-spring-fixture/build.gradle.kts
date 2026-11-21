plugins {
    alias(libs.plugins.spring.boot)
}

description = "Conformance fixture: a Spring Boot + JPA + H2 app that exercises the Java binding over real HTTP."

dependencies {
    implementation(platform(libs.spring.boot.bom))
    implementation(project(":sendproof-jpa"))
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation(libs.springdoc.webmvc.api)
    // The data stores of spec/conformance/fixture.md, each hooked only when the runner passes its variables.
    implementation("org.springframework.boot:spring-boot-starter-data-mongodb")
    implementation("org.springframework.boot:spring-boot-starter-data-redis")
    implementation(platform(libs.awssdk.bom))
    implementation("software.amazon.awssdk:dynamodb")
    runtimeOnly("com.h2database:h2")
}

tasks.bootJar {
    archiveFileName.set("sendproof-java-fixture.jar")
}
