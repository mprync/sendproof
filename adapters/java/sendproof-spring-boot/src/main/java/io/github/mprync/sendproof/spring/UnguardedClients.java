package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.DataStore;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ListableBeanFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.core.env.Environment;

/**
 * Finds client beans of a registered store that Sendproof can't guard, and then refuses Preview for every operation.
 *
 * <p>Cosmos DB's clients are final classes, so no bean can be wrapped: a {@code CosmosClient} or {@code CosmosAsyncClient}
 * bean, or Spring Data Cosmos (its {@code CosmosFactory} and templates hold one), writes past the guard. Spring Data
 * Firestore talks to Firestore through its own gRPC stub ({@code FirestoreGrpc.FirestoreStub}, used by
 * {@code FirestoreTemplate}), whose reactive calls run on threads that carry no request. When such a bean exists and the
 * application registered (or Sendproof hooked) that store, any handler could write through it during a Preview, and
 * nothing would refuse the write. So once every singleton exists, every operation is published as unavailable for
 * Preview, with the reason, and a Preview of any of them is refused before it runs, until the application builds those
 * clients without exposing them as beans and uses the guarded handles.
 */
final class UnguardedClients implements SmartInitializingSingleton {
    private static final Logger LOG = LoggerFactory.getLogger(UnguardedClients.class);

    /** Bean types that are always unguarded, by store id. */
    private static final Map<String, List<String>> UNGUARDED = Map.of(
            "cosmosdb", List.of("com.azure.cosmos.CosmosClient", "com.azure.cosmos.CosmosAsyncClient",
                    "com.azure.spring.data.cosmos.CosmosFactory", "com.azure.spring.data.cosmos.core.CosmosTemplate",
                    "com.azure.spring.data.cosmos.core.ReactiveCosmosTemplate"),
            "firestore", List.of("com.google.firestore.v1.FirestoreGrpc$FirestoreStub",
                    "com.google.cloud.spring.data.firestore.FirestoreTemplate"));

    /** Why Preview is refused: the reason the workbench shows and the stores it names. */
    record Block(String reason, List<String> stores) {
    }

    private final ListableBeanFactory beans;
    private final ObjectProvider<SendproofStores> stores;
    private final Environment environment;
    private volatile Block block;

    UnguardedClients(ListableBeanFactory beans, ObjectProvider<SendproofStores> stores, Environment environment) {
        this.beans = beans;
        this.stores = stores;
        this.environment = environment;
    }

    /** Why every Preview is refused, or {@code null} when nothing unguarded was found. */
    Block block() {
        return block;
    }

    @Override
    public void afterSingletonsInstantiated() {
        SendproofStores all = stores.getIfAvailable();
        if (all == null) {
            return;
        }
        Set<String> registered = new LinkedHashSet<>();
        for (DataStore store : all.all()) {
            registered.add(store.system());
        }
        var found = new ArrayList<String>();
        var named = new LinkedHashSet<String>();
        for (var entry : UNGUARDED.entrySet()) {
            if (!registered.contains(entry.getKey())) {
                continue;
            }
            for (String type : entry.getValue()) {
                for (String bean : beansOf(type)) {
                    found.add(bean);
                    named.add(entry.getKey());
                }
            }
        }
        if (registered.contains("firestore") && !environment.getProperty("sendproof.stores.firestore.enabled", Boolean.class, true)) {
            // A registered FirestoreStore with the Firestore hook off: a Firestore bean is the raw client. (With the hook on,
            // every Firestore bean is replaced as it is created, and FirestoreStoreHook stops startup if one escaped.)
            for (String bean : beansOf("com.google.cloud.firestore.Firestore")) {
                found.add(bean);
                named.add("firestore");
            }
        }
        if (found.isEmpty()) {
            return;
        }
        String stores = String.join(" and ", named.stream().map(StoreGuard::storeName).toList());
        String reason = "Preview unavailable: this application has a " + stores + " client Sendproof doesn't guard (bean '"
                + found.get(0) + "'" + (found.size() > 1 ? " and " + (found.size() - 1) + " more" : "") + ")";
        block = new Block(reason.length() > 512 ? reason.substring(0, 511) + "…" : reason, List.copyOf(named));
        LOG.warn("{}. Every Preview is refused until it is fixed: build those clients inside the beans that hand out the "
                + "guarded handles (CosmosStore.client(...), FirestoreStore.firestore(...)) instead of exposing them as beans. "
                + "Beans: {}", reason, found);
    }

    /** The names of beans of a type, if the type is on the class path; never creates a bean. */
    private List<String> beansOf(String type) {
        Class<?> loaded;
        try {
            loaded = Class.forName(type, false, UnguardedClients.class.getClassLoader());
        } catch (ClassNotFoundException | LinkageError absent) {
            return List.of();
        }
        return List.of(beans.getBeanNamesForType(loaded, true, false));
    }
}
