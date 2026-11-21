package dev.testbench.fixture

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import dev.testbench.jdbc.PreviewDataSource

/** One real relational table, `items`, empty at every process start. Access goes through [dataSource]. */
class Database {
    private val pool = HikariDataSource(
        HikariConfig().apply {
            jdbcUrl = "jdbc:h2:mem:fixture;DB_CLOSE_DELAY=-1"
            maximumPoolSize = 4
        },
    )

    /** The pool wrapped so Test Bench can enroll previews and capture SQL. Handlers must use this. */
    val dataSource = PreviewDataSource(pool) { true }

    init {
        pool.connection.use { connection ->
            connection.createStatement().use {
                it.execute("create table items (id varchar(100) primary key, name varchar(200) not null)")
            }
        }
    }
}
