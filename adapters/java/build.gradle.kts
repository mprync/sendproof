// Shared conventions for the Java bindings. Individual modules declare only what is specific to them.
subprojects {
    group = "io.github.mprync"
    version = (findProperty("sendproof.version") as String?) ?: "0.1.0-alpha.2"

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

        // Every published jar carries the licence, as Maven Central consumers and auditors expect.
        tasks.withType<Jar>().configureEach {
            from(rootDir.resolve("../../LICENSE")) { into("META-INF") }
            manifest.attributes(
                "Implementation-Title" to project.name,
                "Implementation-Version" to project.version.toString(),
            )
        }

        // The repository URL is never stored in this build: the release tooling supplies it with
        // -Psendproof.repositoryUrl=https://<host>/<owner>/<repo>. It is only required when a POM is generated.
        val repositoryUrl = providers.gradleProperty("sendproof.repositoryUrl")
            .map { it.trim().trimEnd('/').removeSuffix(".git") }
        fun requireRepositoryUrl(): String = repositoryUrl.orNull?.takeIf { it.isNotEmpty() }
            ?: throw GradleException(
                "Publishing needs -Psendproof.repositoryUrl=https://<host>/<owner>/<repo>; the URL is not stored in the build.",
            )
        fun developerConnection(url: String): String =
            Regex("^https://([^/]+)/(.+)$").matchEntire(url)?.let { "scm:git:ssh://git@${it.groupValues[1]}/${it.groupValues[2]}.git" }
                ?: "scm:git:$url.git"

        extensions.configure<PublishingExtension> {
            publications.create<MavenPublication>("maven") {
                from(components["java"])
                versionMapping { allVariants { fromResolutionResult() } }
                pom {
                    name.set(project.name)
                    // Central rejects a component without a description, so a missing one fails the build.
                    description.set(provider {
                        project.description?.takeIf { it.isNotBlank() }
                            ?: throw GradleException("${project.path} is published and needs a description in its build.gradle.kts.")
                    })
                    url.set(provider { requireRepositoryUrl() })
                    licenses {
                        license {
                            name.set("MIT")
                            url.set("https://opensource.org/license/mit")
                            distribution.set("repo")
                        }
                    }
                    developers {
                        developer {
                            id.set("sendproof")
                            name.set("Sendproof contributors")
                        }
                    }
                    scm {
                        url.set(provider { requireRepositoryUrl() })
                        connection.set(provider { "scm:git:${requireRepositoryUrl()}.git" })
                        developerConnection.set(provider { developerConnection(requireRepositoryUrl()) })
                    }
                    issueManagement {
                        system.set("GitHub Issues")
                        url.set(provider { "${requireRepositoryUrl()}/issues" })
                    }
                }
            }
            // `./gradlew publish` writes a Maven layout here so the artifacts can be inspected locally.
            // The release tooling redirects it with -Psendproof.repoDir=<dir>.
            repositories {
                maven {
                    name = "local"
                    url = providers.gradleProperty("sendproof.repoDir")
                        .map { uri(file(it)) }
                        .orElse(rootProject.layout.buildDirectory.dir("repo").map { it.asFile.toURI() })
                        .get()
                }
            }
        }
    }
}
