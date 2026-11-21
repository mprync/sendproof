plugins {
    java
    id("org.springframework.boot") version "@SPRING_BOOT@"
}

repositories {
    // Only the packed artifacts supply io.github.mprync, so the source tree can never leak into the test.
    maven {
        url = uri("@REPOSITORY@")
        content { includeGroup("io.github.mprync") }
    }
    mavenCentral()
}

// Compile for Java 17 with whichever JDK 17+ runs Gradle; no toolchain download is ever attempted.
tasks.withType<JavaCompile>().configureEach { options.release.set(17) }

// Proves the Kotlin artifact and its Gradle module metadata resolve, without putting Ktor in the Spring app.
val ktorCheck by configurations.creating {
    isCanBeConsumed = false
    attributes {
        attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage.JAVA_API))
        attribute(Category.CATEGORY_ATTRIBUTE, objects.named(Category.LIBRARY))
    }
}

dependencies {
    implementation(platform("org.springframework.boot:spring-boot-dependencies:@SPRING_BOOT@"))
    implementation("io.github.mprync:sendproof-spring-boot:@VERSION@")
    implementation("org.springframework.boot:spring-boot-starter-web")
    ktorCheck("io.github.mprync:sendproof-ktor:@VERSION@")
}

// Tells the Node script which JVM Gradle used, so the app runs on the same JDK 17+ on every platform.
val resolveConsumer by tasks.registering {
    val javaHome = layout.buildDirectory.file("consumer/java-home.txt")
    val ktorFiles = layout.buildDirectory.file("consumer/ktor-classpath.txt")
    val ktorClasspath = ktorCheck.incoming.files
    outputs.files(javaHome, ktorFiles)
    doLast {
        javaHome.get().asFile.apply { parentFile.mkdirs(); writeText(System.getProperty("java.home")) }
        ktorFiles.get().asFile.writeText(ktorClasspath.files.joinToString("\n") { it.name })
    }
}

tasks.bootJar {
    archiveFileName.set("consumer.jar")
    dependsOn(resolveConsumer)
}
