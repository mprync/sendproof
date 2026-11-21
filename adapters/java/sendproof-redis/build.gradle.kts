description = "Redis write guard: guarded Spring Data Redis connections and a guarded Jedis client that refuse writes during a Preview and log commands."

dependencies {
    val bom = platform(rootProject.libs.spring.boot.bom)
    compileOnly(bom)
    testImplementation(bom)

    api(project(":sendproof-core"))
    // The Redis clients are the host's choice and version: each entry point names the one it needs.
    compileOnly("org.springframework.data:spring-data-redis")
    compileOnly("org.springframework:spring-aop")
    compileOnly("redis.clients:jedis")

    testImplementation("org.springframework.data:spring-data-redis")
    testImplementation("io.lettuce:lettuce-core")
    testImplementation("redis.clients:jedis")
    testImplementation("org.springframework:spring-aop")
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation("org.assertj:assertj-core")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testRuntimeOnly("org.slf4j:slf4j-simple")
}
