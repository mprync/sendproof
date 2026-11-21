package io.github.mprync.sendproof.ktor

import com.mongodb.kotlin.client.coroutine.MongoClient
import io.github.mprync.sendproof.mongodb.MongoStore
import com.mongodb.reactivestreams.client.MongoClient as ReactiveMongoClient

/**
 * Attaches the reactive streams client underneath Kotlin's coroutine driver and returns the guarded coroutine client the
 * application uses. During a Preview each call joins the Preview's transaction (or is refused, in guard mode), and a
 * write that bypasses it fails the Preview.
 *
 * Build the reactive client with the store's listener and context provider, so the tripwire can see every command and find
 * the request it belongs to:
 *
 * ```kotlin
 * val store = MongoStore.builder().name("catalog").build()
 * val reactive = MongoClients.create(
 *     MongoClientSettings.builder()
 *         .applyConnectionString(ConnectionString(url))
 *         .addCommandListener(store.commandListener())
 *         .contextProvider(store.reactiveContextProvider() as ReactiveContextProvider)
 *         .build(),
 * )
 * val client = store.coroutine(reactive)           // handlers use this one
 * install(Sendproof) { dataStores += store }
 * ```
 */
public fun MongoStore.coroutine(client: ReactiveMongoClient): MongoClient = MongoClient(reactive(client))
