description = "Logback appender that copies a Sendproof request's log events into its capture."

dependencies {
    api(project(":sendproof-core"))
    compileOnly(platform(rootProject.libs.spring.boot.bom))
    compileOnly("ch.qos.logback:logback-classic")
}
