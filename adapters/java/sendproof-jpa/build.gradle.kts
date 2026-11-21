description = "JPA/Hibernate and Spring-managed JDBC integration: rollback-only previews, change capture and SQL capture."

dependencies {
    val bom = platform(rootProject.libs.spring.boot.bom)
    implementation(bom)
    testImplementation(bom)
    annotationProcessor(bom)
    annotationProcessor("org.springframework.boot:spring-boot-configuration-processor")

    api(project(":sendproof-core"))
    api(project(":sendproof-spring-boot"))
    api(project(":sendproof-jdbc"))
    api("org.springframework:spring-tx")
    api("org.springframework:spring-jdbc")

    compileOnly("jakarta.persistence:jakarta.persistence-api")
    compileOnly("org.springframework:spring-orm")
    compileOnly("org.hibernate.orm:hibernate-core")
    compileOnly("org.springframework.boot:spring-boot-autoconfigure")
    compileOnly("org.springframework.boot:spring-boot-starter-data-jpa")
    compileOnly("jakarta.servlet:jakarta.servlet-api")

    testImplementation("org.springframework.boot:spring-boot-starter-web")
    testImplementation("org.springframework.boot:spring-boot-starter-data-jpa")
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("com.h2database:h2")
    // MySqlJpaEscapeTest runs against the compose MySQL when it answers, and is skipped otherwise.
    testImplementation("com.mysql:mysql-connector-j")
    testImplementation("org.mariadb.jdbc:mariadb-java-client")
    // SqlServerJpaTest runs against the compose SQL Server when it answers, and is skipped otherwise.
    testImplementation("com.microsoft.sqlserver:mssql-jdbc")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
