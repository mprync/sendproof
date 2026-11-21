package io.github.mprync.sendproof.fixture

import com.mongodb.ConnectionString
import com.mongodb.MongoClientSettings
import com.mongodb.kotlin.client.coroutine.MongoClient
import com.mongodb.kotlin.client.coroutine.MongoCollection
import com.mongodb.reactivestreams.client.MongoClients
import com.mongodb.reactivestreams.client.ReactiveContextProvider
import io.github.mprync.sendproof.core.DataStore
import io.github.mprync.sendproof.dynamodb.DynamoDbStore
import io.github.mprync.sendproof.ktor.coroutine
import io.github.mprync.sendproof.mongodb.MongoStore
import io.github.mprync.sendproof.redis.RedisStore
import java.net.URI
import org.bson.Document
import redis.clients.jedis.DefaultJedisClientConfig
import redis.clients.jedis.HostAndPort
import redis.clients.jedis.JedisPooled
import software.amazon.awssdk.auth.credentials.EnvironmentVariableCredentialsProvider
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.dynamodb.DynamoDbClient

/** The MongoDB collection of the fixture contract, through the guarded coroutine driver. */
class MongoFixture(url: String) {
    val store: MongoStore = MongoStore.builder().name("catalog").build()
    private val reactive = MongoClients.create(
        MongoClientSettings.builder()
            .applyConnectionString(ConnectionString(url))
            // The tripwire: every command the client sends is seen, in the request that sent it.
            .addCommandListener(store.commandListener())
            .contextProvider(store.reactiveContextProvider() as ReactiveContextProvider)
            .build(),
    )

    /** The guarded client: handlers use this one, never the reactive client underneath. */
    val client: MongoClient = store.coroutine(reactive)
    val documents: MongoCollection<Document> =
        client.getDatabase(checkNotNull(ConnectionString(url).database) { "BENCH_MONGODB_URL names no database" })
            .getCollection<Document>("documents")
}

/** Redis through Jedis, whose every connection is guarded. Counters live at `<prefix>counter:<key>`. */
class RedisFixture(url: String, val prefix: String) {
    val store: RedisStore = RedisStore.builder().name("cache").build()
    val jedis: JedisPooled

    init {
        val uri = URI.create(url)
        val config = DefaultJedisClientConfig.builder().apply {
            uri.userInfo?.substringAfter(':', "")?.takeIf { it.isNotEmpty() }?.let { password(it) }
        }.build()
        jedis = store.jedis(HostAndPort(uri.host, uri.port), config)
    }

    fun key(name: String) = "${prefix}counter:$name"
}

/** DynamoDB through the AWS SDK v2 client with the Sendproof interceptor. */
class DynamoFixture(url: String, val table: String) {
    val store: DynamoDbStore = DynamoDbStore.interceptor().name("orders").build()
    val client: DynamoDbClient = DynamoDbClient.builder()
        .endpointOverride(URI.create(url))
        .region(Region.of(System.getenv("AWS_REGION") ?: "us-east-1"))
        .credentialsProvider(EnvironmentVariableCredentialsProvider.create())
        .overrideConfiguration { it.addExecutionInterceptor(store) }
        .build()
}

/** The data stores the runner asked for, each present only when its variables are set. */
class Stores(
    val mongo: MongoFixture? = System.getenv("BENCH_MONGODB_URL")?.let { MongoFixture(it) },
    val redis: RedisFixture? = System.getenv("BENCH_REDIS_URL")?.let { RedisFixture(it, System.getenv("BENCH_REDIS_PREFIX") ?: "") },
    val dynamo: DynamoFixture? = System.getenv("BENCH_DYNAMODB_URL")?.let {
        DynamoFixture(it, checkNotNull(System.getenv("BENCH_DYNAMODB_TABLE")))
    },
) {
    companion object {
        /** No stores, for the scenario that disables Sendproof. */
        fun none() = Stores(null, null, null)
    }

    /** The hooks to register with the plugin. */
    val all: List<DataStore> get() = listOfNotNull(mongo?.store, redis?.store, dynamo?.store)
}
