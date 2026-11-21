// Throwaway consumer for the Maven Central smoke test. tools/release/maven.mjs copies this directory to a
// temporary location and fills in the @PLACEHOLDERS@ below; nothing here is built inside the repository.
rootProject.name = "sendproof-maven-consumer"

pluginManagement {
    repositories { gradlePluginPortal(); mavenCentral() }
}
