package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.core.DataStore;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Supplier;

/**
 * The data stores of the application: those registered on the {@link Sendproof} builder or as {@link DataStore} beans,
 * and the ones Spring Boot hooks itself (Spring Data MongoDB and Spring Data Redis) when the host named none.
 */
final class SendproofStores {
    private final List<DataStore> registered;
    private final List<DataStore> automatic = new CopyOnWriteArrayList<>();

    SendproofStores(List<DataStore> registered) {
        this.registered = List.copyOf(registered);
    }

    /** Every store, registered ones first. */
    List<DataStore> all() {
        var all = new ArrayList<>(registered);
        all.addAll(automatic);
        return all;
    }

    /**
     * The registered store of {@code type}, or a new automatic one made by {@code create}.
     *
     * @return the store
     */
    synchronized <T extends DataStore> T of(Class<T> type, Supplier<T> create) {
        for (DataStore store : registered) {
            if (type.isInstance(store)) {
                return type.cast(store);
            }
        }
        for (DataStore store : automatic) {
            if (type.isInstance(store)) {
                return type.cast(store);
            }
        }
        T created = create.get();
        automatic.add(created);
        return created;
    }

    /** Whether any store is registered or hooked. */
    boolean any() {
        return !registered.isEmpty() || !automatic.isEmpty();
    }
}
