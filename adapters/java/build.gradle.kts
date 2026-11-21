// Shared conventions for the Java bindings. Individual modules declare only what is specific to them.
subprojects {
    group = "dev.testbench"
    version = (findProperty("testbench.version") as String?) ?: "0.1.0-alpha.1"

    apply(plugin = "java-library")

    tasks.withType<JavaCompile>().configureEach {
        options.release.set(17)
        options.encoding = "UTF-8"
        options.compilerArgs.addAll(listOf("-parameters", "-Xlint:all,-serial,-processing"))
    }

    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
        testLogging {
            events("failed", "skipped")
            exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        }
    }

    if (name != "spring-fixture" && name != "ktor-fixture") {
        apply(plugin = "maven-publish")
        extensions.configure<JavaPluginExtension> {
            withSourcesJar()
            withJavadocJar()
        }
        extensions.configure<PublishingExtension> {
            publications.create<MavenPublication>("maven") {
                from(components["java"])
                versionMapping { allVariants { fromResolutionResult() } }
                pom {
                    name.set(project.name)
                    url.set("https://github.com/testbench/test-bench")
                    licenses { license { name.set("MIT") } }
                }
            }
            // `./gradlew publish` writes a Maven layout here so the artifacts can be inspected locally.
            repositories { maven { name = "local"; url = uri(rootProject.layout.buildDirectory.dir("repo")) } }
        }
    }
}
