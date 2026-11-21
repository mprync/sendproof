description = "Logback appender that copies a Test Bench request's log events into its capture."

dependencies {
    api(project(":testbench-core"))
    compileOnly(platform(rootProject.libs.spring.boot.bom))
    compileOnly("ch.qos.logback:logback-classic")
}
