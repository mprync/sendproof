rootProject.name = "testbench-java"

include("testbench-core", "testbench-ui", "testbench-jdbc", "testbench-logback", "testbench-spring-boot", "testbench-jpa", "testbench-ktor", "spring-fixture", "ktor-fixture")

// The conformance fixture lives with the other examples but builds with the adapters.
project(":spring-fixture").projectDir = file("../../examples/java-spring-fixture")
project(":ktor-fixture").projectDir = file("../../examples/kotlin-ktor-fixture")

dependencyResolutionManagement {
    repositories { mavenCentral() }
}
