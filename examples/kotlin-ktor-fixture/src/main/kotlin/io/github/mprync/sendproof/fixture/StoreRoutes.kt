package io.github.mprync.sendproof.fixture

import com.mongodb.client.model.Filters
import com.mongodb.client.model.Updates
import io.github.mprync.sendproof.ktor.sendproofPreview
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.install
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import kotlin.collections.get
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.withContext
import org.bson.Document
import org.slf4j.LoggerFactory
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.ExecuteStatementRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest

private val log = LoggerFactory.getLogger("StoreRoutes")

private suspend fun ApplicationCall.body(): Map<String, Any?> = runCatching { receive<Map<String, Any?>>() }.getOrNull().orEmpty()

/** The MongoDB routes of the fixture contract, through the guarded coroutine driver. */
fun Route.documentRoutes(accounts: Accounts, mongo: MongoFixture) {
    fun view(document: Document): Map<String, Any?> =
        mapOf("id" to document["_id"], "name" to document["name"], "city" to document.get("profile", Document::class.java)?.get("city"))

    route("/documents") {
        install(Secured) { this.accounts = accounts }
        sendproofPreview {
            get("/{id}") {
                val document = mongo.documents.find(Filters.eq("_id", call.parameters["id"]!!)).firstOrNull()
                if (document == null) call.respond(HttpStatusCode.NotFound) else call.respond(view(document))
            }
            post {
                val body = call.body()
                val document = Document("_id", body["id"]).append("name", body["name"])
                    .append("profile", Document("city", body["city"])).append("password_hash", "hashed:${body["password"]}")
                mongo.documents.insertOne(document)
                log.info("created-document:{}", body["id"])
                call.respond(HttpStatusCode.Created, view(document))
            }
            patch("/{id}") {
                val body = call.body()
                val updates = listOfNotNull(
                    (body["name"] as? String)?.let { Updates.set("name", it) },
                    (body["city"] as? String)?.let { Updates.set("profile.city", it) },
                )
                val id = call.parameters["id"]!!
                val matched = if (updates.isEmpty()) 0 else mongo.documents.updateOne(Filters.eq("_id", id), Updates.combine(updates)).matchedCount
                val updated = if (matched == 0L) null else mongo.documents.find(Filters.eq("_id", id)).firstOrNull()
                if (updated == null) call.respond(HttpStatusCode.NotFound) else call.respond(view(updated))
            }
            // $out can't run inside a transaction: the binding blocks it before sending.
            post("/archive") {
                mongo.documents.aggregate<Document>(listOf(Document("\$match", Document()), Document("\$out", "documents_archive"))).toCollection()
                call.respond(HttpStatusCode.NoContent)
            }
        }
        sendproofPreview(enabled = false, stores = listOf("mongodb")) {
            delete("/{id}") {
                mongo.documents.deleteOne(Filters.eq("_id", call.parameters["id"]!!))
                call.respond(HttpStatusCode.NoContent)
            }
        }
    }
}

/** The Redis routes of the fixture contract, through Jedis. */
fun Route.counterRoutes(accounts: Accounts, redis: RedisFixture) {
    route("/counters") {
        install(Secured) { this.accounts = accounts }
        sendproofPreview {
            get("/{key}") {
                val name = call.parameters["key"]!!
                val value = withContext(Dispatchers.IO) { redis.jedis.get(redis.key(name)) }
                if (value == null) call.respond(HttpStatusCode.NotFound) else call.respond(mapOf("key" to name, "value" to value.toLong()))
            }
            post("/{key}") {
                val name = call.parameters["key"]!!
                call.respond(mapOf("key" to name, "value" to withContext(Dispatchers.IO) { redis.jedis.incr(redis.key(name)) }))
            }
            // GETDEL looks like a read but deletes the key: a write.
            post("/{key}/take") {
                val name = call.parameters["key"]!!
                val value = withContext(Dispatchers.IO) { redis.jedis.getDel(redis.key(name)) }
                if (value == null) call.respond(HttpStatusCode.NotFound) else call.respond(mapOf("key" to name, "value" to value.toLong()))
            }
        }
        sendproofPreview(enabled = false, stores = listOf("redis")) {
            delete("/{key}") {
                withContext(Dispatchers.IO) { redis.jedis.del(redis.key(call.parameters["key"]!!)) }
                call.respond(HttpStatusCode.NoContent)
            }
        }
    }
}

/** The DynamoDB routes of the fixture contract, through the AWS SDK v2 client. */
fun Route.orderRoutes(accounts: Accounts, dynamo: DynamoFixture) {
    fun view(item: Map<String, AttributeValue>): Map<String, Any?> =
        mapOf("id" to item["id"]!!.s(), "status" to item["status"]!!.s(), "hits" to item["hits"]!!.n().toInt())

    route("/orders") {
        install(Secured) { this.accounts = accounts }
        sendproofPreview {
            get("/{id}") {
                val id = call.parameters["id"]!!
                val response = withContext(Dispatchers.IO) {
                    dynamo.client.getItem(GetItemRequest.builder().tableName(dynamo.table).key(mapOf("id" to AttributeValue.fromS(id))).build())
                }
                if (response.hasItem()) call.respond(view(response.item())) else call.respond(HttpStatusCode.NotFound)
            }
            post("/{id}/touch") { call.respond(view(touchOrder(dynamo, call.parameters["id"]!!))) }
            // A PartiQL UPDATE travels through ExecuteStatement, which also carries reads.
            post("/{id}/cancel") {
                val id = call.parameters["id"]!!
                withContext(Dispatchers.IO) {
                    dynamo.client.executeStatement(
                        ExecuteStatementRequest.builder().statement("UPDATE \"${dynamo.table}\" SET status = 'cancelled' WHERE id = ?")
                            .parameters(AttributeValue.fromS(id)).build(),
                    )
                }
                call.respond(mapOf("id" to id, "status" to "cancelled"))
            }
        }
        sendproofPreview(enabled = false, stores = listOf("dynamodb")) {
            delete("/{id}") {
                withContext(Dispatchers.IO) {
                    dynamo.client.deleteItem(
                        DeleteItemRequest.builder().tableName(dynamo.table).key(mapOf("id" to AttributeValue.fromS(call.parameters["id"]!!))).build(),
                    )
                }
                call.respond(HttpStatusCode.NoContent)
            }
        }
    }
}

/** `ADD hits :one SET #s = if_not_exists(#s, :new)` with `ALL_NEW`; shared with the mixed SQL and store route. */
suspend fun touchOrder(dynamo: DynamoFixture, id: String): Map<String, AttributeValue> = withContext(Dispatchers.IO) {
    dynamo.client.updateItem(
        UpdateItemRequest.builder().tableName(dynamo.table).key(mapOf("id" to AttributeValue.fromS(id)))
            .updateExpression("ADD hits :one SET #s = if_not_exists(#s, :new)")
            .expressionAttributeNames(mapOf("#s" to "status"))
            .expressionAttributeValues(mapOf(":one" to AttributeValue.fromN("1"), ":new" to AttributeValue.fromS("new")))
            .returnValues("ALL_NEW").build(),
    ).attributes()
}

/** The Cassandra routes of the fixture contract, through the guarded session. */
fun Route.ticketRoutes(accounts: Accounts, cassandra: CassandraFixture) {
    val select by lazy { cassandra.session.prepare("SELECT id, status, hits FROM tickets WHERE id = ?") }
    route("/tickets") {
        install(Secured) { this.accounts = accounts }
        sendproofPreview {
            get("/{id}") {
                val id = call.parameters["id"]!!
                val row = withContext(Dispatchers.IO) { cassandra.session.execute(select.bind(id)).one() }
                if (row == null) call.respond(HttpStatusCode.NotFound)
                else call.respond(mapOf("id" to row.getString("id"), "status" to row.getString("status"), "hits" to row.getInt("hits")))
            }
            post("/{id}/touch") {
                touchTicket(cassandra, call.parameters["id"]!!)
                call.respond(mapOf("id" to call.parameters["id"]!!, "status" to "new", "hits" to 1))
            }
            // A logged batch holding a lightweight transaction: a write even though its condition could fail.
            post("/{id}/close") {
                val id = call.parameters["id"]!!
                withContext(Dispatchers.IO) {
                    cassandra.session.execute(
                        com.datastax.oss.driver.api.core.cql.BatchStatement.newInstance(
                            com.datastax.oss.driver.api.core.cql.BatchType.LOGGED,
                            com.datastax.oss.driver.api.core.cql.SimpleStatement.newInstance("UPDATE tickets SET status = 'closed' WHERE id = ? IF EXISTS", id),
                        ),
                    )
                }
                call.respond(mapOf("id" to id, "status" to "closed"))
            }
        }
        sendproofPreview(enabled = false, stores = listOf("cassandra")) {
            delete("/{id}") {
                withContext(Dispatchers.IO) {
                    cassandra.session.execute(
                        com.datastax.oss.driver.api.core.cql.SimpleStatement.newInstance("DELETE FROM tickets WHERE id = ?", call.parameters["id"]!!),
                    )
                }
                call.respond(HttpStatusCode.NoContent)
            }
        }
    }
}

/** `INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)`; shared with the mixed SQL and store route. */
suspend fun touchTicket(cassandra: CassandraFixture, id: String) {
    withContext(Dispatchers.IO) {
        cassandra.session.execute(
            com.datastax.oss.driver.api.core.cql.SimpleStatement.newInstance("INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)", id),
        )
    }
}

/** The OpenSearch routes of the fixture contract, through the typed client over the guarded transport. */
fun Route.articleRoutes(accounts: Accounts, search: OpenSearchFixture) {
    fun view(id: String, source: Map<*, *>): Map<String, Any?> =
        mapOf("id" to id, "title" to source["title"], "views" to (source["views"] as Number).toInt())

    route("/articles") {
        install(Secured) { this.accounts = accounts }
        sendproofPreview {
            // A read sent as a POST to _search.
            get("/{id}") {
                val id = call.parameters["id"]!!
                val hits = withContext(Dispatchers.IO) {
                    search.client.search({ s -> s.index(search.index).query { q -> q.ids { i -> i.values(id) } }.size(1) }, Map::class.java).hits().hits()
                }
                if (hits.isEmpty()) call.respond(HttpStatusCode.NotFound) else call.respond(view(id, hits[0].source()!!))
            }
            post("/{id}/touch") {
                val id = call.parameters["id"]!!
                call.respond(touchArticle(search, id))
            }
            // _update_by_query is a POST with a query, like a search. The store error is swallowed to 404 on purpose.
            post("/{id}/hide") {
                val id = call.parameters["id"]!!
                val updated = runCatching {
                    withContext(Dispatchers.IO) {
                        search.client.updateByQuery { u ->
                            u.index(search.index).refresh(true).query { q -> q.ids { i -> i.values(id) } }
                                .script { s -> s.inline { i -> i.source("ctx._source.hidden = true") } }
                        }.updated()
                    }
                }.getOrNull()
                if (updated != null && updated > 0) call.respond(mapOf("id" to id, "hidden" to true)) else call.respond(HttpStatusCode.NotFound)
            }
        }
        sendproofPreview(enabled = false, stores = listOf("opensearch")) {
            delete("/{id}") {
                withContext(Dispatchers.IO) {
                    search.client.delete { d -> d.index(search.index).id(call.parameters["id"]!!).refresh(org.opensearch.client.opensearch._types.Refresh.True) }
                }
                call.respond(HttpStatusCode.NoContent)
            }
        }
    }
}

/** `POST /<index>/_update/<id>` with the `views` script and an upsert; shared with the mixed SQL and store route. */
suspend fun touchArticle(search: OpenSearchFixture, id: String): Map<String, Any?> = withContext(Dispatchers.IO) {
    val request = org.opensearch.client.opensearch.core.UpdateRequest.Builder<Map<*, *>, Map<*, *>>()
        .index(search.index).id(id).refresh(org.opensearch.client.opensearch._types.Refresh.True)
        .script { s -> s.inline { i -> i.source("ctx._source.views += params.step").params("step", org.opensearch.client.json.JsonData.of(1)) } }
        .upsert(mapOf("title" to "Untitled", "views" to 1)).source { c -> c.fetch(true) }.build()
    val reply = search.client.update(request, Map::class.java)
    val source = reply.get()!!.source()!!
    mapOf("id" to id, "title" to source["title"], "views" to (source["views"] as Number).toInt())
}
