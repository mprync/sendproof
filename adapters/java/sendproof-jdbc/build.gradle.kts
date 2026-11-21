description = "Framework-neutral JDBC integration: connection enrollment, SQL capture and row-change capture."

dependencies {
    val bom = platform(rootProject.libs.spring.boot.bom)
    implementation(bom)
    testImplementation(bom)

    api(project(":sendproof-core"))
    api(rootProject.libs.datasource.proxy)

    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation("org.assertj:assertj-core")
    testImplementation("com.h2database:h2")
    // MySqlEscapeTest runs against the compose MySQL when it answers, and skips otherwise.
    testImplementation("com.mysql:mysql-connector-j")
    // SqlServerAbortTest runs against the compose SQL Server when it answers, and skips otherwise.
    testImplementation("com.microsoft.sqlserver:mssql-jdbc")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testRuntimeOnly("org.slf4j:slf4j-simple")
}
