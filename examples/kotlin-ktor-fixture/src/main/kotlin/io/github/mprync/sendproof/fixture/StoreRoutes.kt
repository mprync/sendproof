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
