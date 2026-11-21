package io.github.mprync.sendproof.fixture

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import io.github.mprync.sendproof.jdbc.PreviewDataSource

/** Two real relational tables, `items` and `accounts`, empty at every process start. Access goes through [dataSource]. */
class Database {
    private val pool = HikariDataSource(
        HikariConfig().apply {
            jdbcUrl = "jdbc:h2:mem:fixture;DB_CLOSE_DELAY=-1"
            maximumPoolSize = 4
        },
    )

    /** The pool wrapped so Sendproof can enroll previews and capture SQL. Handlers must use this. */
    val dataSource = PreviewDataSource(pool) { true }

    init {
        pool.connection.use { connection ->
            connection.createStatement().use {
                it.execute("create table items (id varchar(100) primary key, name varchar(200) not null)")
                it.execute(
                    "create table accounts (id varchar(100) primary key, email varchar(200) not null, " +
                        "password_hash varchar(200) not null)",
                )
            }
        }
    }
}
