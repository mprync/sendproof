package dev.testbench.fixture

import dev.testbench.core.TestBenchCapture
import java.sql.Connection
import org.slf4j.LoggerFactory

data class Item(val id: String, val name: String)

class DuplicateItem(id: String) : RuntimeException("Item $id already exists.")

/**
 * The fixture's data access. Every operation is one unit of work on a connection borrowed from the
 * [Database.dataSource]: ordinary sends commit it, previews share one connection that is rolled back.
 */
class Items(private val db: Database, private val capture: TestBenchCapture) {
    private val log = LoggerFactory.getLogger(Items::class.java)

    private fun <T> unit(work: (Connection) -> T): T = db.dataSource.connection.use { connection ->
        try {
            work(connection).also { connection.commit() }
        } catch (error: Throwable) {
            connection.rollback()
            throw error
        }
    }

    fun find(id: String): Item? = db.dataSource.connection.use { connection ->
        connection.prepareStatement("select id, name from items where id = ?").use { statement ->
            statement.setString(1, id)
            statement.executeQuery().use { rows -> if (rows.next()) Item(rows.getString(1), rows.getString(2)) else null }
        }
    }

    private fun insert(connection: Connection, id: String, name: String) {
        if (connection.prepareStatement("select count(*) from items where id = ?").use { statement ->
                statement.setString(1, id)
                statement.executeQuery().use { it.next() && it.getInt(1) > 0 }
            }
        ) {
            throw DuplicateItem(id)
        }
        connection.prepareStatement("insert into items (id, name) values (?, ?)").use { statement ->
            statement.setString(1, id)
            statement.setString(2, name)
            statement.executeUpdate()
        }
    }

    /** Inserts an item, reports the "Created item" email effect and runs a statement with a secret-named binding. */
    fun create(id: String, name: String): Item = unit { connection ->
        insert(connection, id, name)
        log.info("created:{}", id)
        // A bound parameter whose name marks it secret; adapters must never show its value.
        connection.prepareStatement("select cast(? as varchar) as fixture_secret").use { statement ->
            statement.setString(1, "fixture-secret-value")
            statement.executeQuery().use { it.next() }
        }
        capture.tryRecordEmail(
            "Created item", "fixture@example.test", listOf("ops@example.test"), emptyList(),
            "Item created", "Item $id was created.", null,
        )
        Item(id, name)
    }

    fun rename(id: String, name: String): Item? = unit { connection ->
        val updated = connection.prepareStatement("update items set name = ? where id = ?").use { statement ->
            statement.setString(1, name)
            statement.setString(2, id)
            statement.executeUpdate()
        }
        if (updated == 0) null else Item(id, name)
    }

    fun delete(id: String) = unit { connection ->
        connection.prepareStatement("delete from items where id = ?").use { statement ->
            statement.setString(1, id)
            statement.executeUpdate()
        }
    }

    /** Inserts and then fails with a handled application error; nothing persists in either mode. */
    fun insertThenFail(id: String): Nothing = unit<Nothing> { connection ->
        insert(connection, id, "failing")
        throw HandledFailure()
    }

    fun insertPlain(id: String, name: String): Item = unit { connection ->
        insert(connection, id, name)
        Item(id, name)
    }

    /** Exceeds the default caps: 205 changes, 105 effects and 505 log lines in one request. */
    fun capture(prefix: String): Int = unit { connection ->
        for (i in 0 until 205) insert(connection, "$prefix-$i", "Bulk $i")
        for (i in 0 until 105) capture.tryRecordEffect("message", "Bulk effect $i", mapOf("topic" to "bulk", "n" to i))
        for (i in 0 until 505) log.info("capture-line:{}", i)
        205
    }
}

class HandledFailure : RuntimeException("Handled application failure.")
