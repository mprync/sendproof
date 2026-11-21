rootProject.name = "sendproof-java"

include("sendproof-core", "sendproof-ui", "sendproof-jdbc", "sendproof-logback", "sendproof-spring-boot", "sendproof-jpa", "sendproof-ktor", "spring-fixture", "ktor-fixture")

// The conformance fixture lives with the other examples but builds with the adapters.
project(":spring-fixture").projectDir = file("../../examples/java-spring-fixture")
project(":ktor-fixture").projectDir = file("../../examples/kotlin-ktor-fixture")

dependencyResolutionManagement {
    repositories { mavenCentral() }
}
