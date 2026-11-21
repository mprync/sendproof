package io.github.mprync.sendproof.mongodb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.mongodb.ConnectionString;
import com.mongodb.MongoClientSettings;
import com.mongodb.event.CommandListener;
import com.mongodb.event.CommandStartedEvent;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import org.bson.Document;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Pins the driver behaviour {@link PreviewSessions} relies on to tell the driver's own originator check from handler
 * code: handed a session from another client, both drivers ask the session for its originator from a
 * {@code com.mongodb.*} frame ({@link PreviewSessions#calledByDriver()} answers true there) and refuse before sending
 * any command. If a driver upgrade changes either, this test fails and the session guard needs another signal.
 * Runs against the compose replica set and skips when it doesn't answer.
 */
class DriverOriginatorCheckTest {
    private static final String URL = System.getenv().getOrDefault("BENCH_MONGODB_SERVER_URL",
            "mongodb://127.0.0.1:57017/?directConnection=true");
    private static boolean available;

    @BeforeAll
    static void probe() {
        try (var probe = com.mongodb.client.MongoClients.create(MongoClientSettings.builder()
                .applyConnectionString(new ConnectionString(URL))
                .applyToClusterSettings(cluster -> cluster.serverSelectionTimeout(2, java.util.concurrent.TimeUnit.SECONDS))
                .build())) {
            probe.getDatabase("admin").runCommand(new Document("hello", 1));
            available = true;
        } catch (RuntimeException unreachable) {
            available = false;
        }
    }

    /** Records every command a client starts. */
    private static final class Sent implements CommandListener {
        final List<String> commands = new CopyOnWriteArrayList<>();

        @Override
        public void commandStarted(CommandStartedEvent event) {
            commands.add(event.getCommandName());
        }
    }

    private static MongoClientSettings settings(Sent sent) {
        return MongoClientSettings.builder().applyConnectionString(new ConnectionString(URL)).addCommandListener(sent).build();
    }

    /**
     * Wraps {@code real} so {@code getOriginator()} answers {@code foreign} and records whether
     * {@link PreviewSessions#calledByDriver()} recognised the caller as the driver.
     */
    @SuppressWarnings("unchecked")
    private static <T> T session(Class<T> type, Object real, Object foreign, AtomicBoolean askedByDriver) {
        return (T) Proxy.newProxyInstance(DriverOriginatorCheckTest.class.getClassLoader(), new Class<?>[] {type},
                (proxy, method, args) -> {
                    if (method.getName().equals("getOriginator")) {
                        if (PreviewSessions.calledByDriver(DriverOriginatorCheckTest.class)) {
                            askedByDriver.set(true);
                        }
                        return foreign;
                    }
                    try {
                        return method.invoke(real, args);
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
    }

    @Test
    void theSyncDriverAsksTheSessionsOriginatorFromItsOwnCodeAndRefusesBeforeSending() {
        assumeTrue(available, "MongoDB isn't running: docker compose -f tests/conformance/compose.yml up -d --wait mongodb");
        var sent = new Sent();
        try (var owner = com.mongodb.client.MongoClients.create(settings(new Sent()));
             var other = com.mongodb.client.MongoClients.create(settings(sent));
             var real = owner.startSession()) {
            var asked = new AtomicBoolean();
            var foreign = session(com.mongodb.client.ClientSession.class, real, owner, asked);
            sent.commands.clear();
            assertThatThrownBy(() -> other.getDatabase("admin").runCommand(foreign, new Document("ping", 1)))
                    .isInstanceOf(IllegalStateException.class).hasMessageContaining("ClientSession from same MongoClient");
            assertThat(asked).as("the driver asked for the originator from a com.mongodb.* frame").isTrue();
            assertThat(sent.commands).as("nothing was sent").isEmpty();
        }
    }

    @Test
    void theReactiveDriverAsksTheSessionsOriginatorFromItsOwnCodeAndRefusesBeforeSending() {
        assumeTrue(available, "MongoDB isn't running: docker compose -f tests/conformance/compose.yml up -d --wait mongodb");
        var sent = new Sent();
        try (var owner = com.mongodb.reactivestreams.client.MongoClients.create(settings(new Sent()));
             var other = com.mongodb.reactivestreams.client.MongoClients.create(settings(sent))) {
            var real = ReactiveBackend.first(owner.startSession());
            try {
                var asked = new AtomicBoolean();
                var foreign = session(com.mongodb.reactivestreams.client.ClientSession.class, real, owner, asked);
                sent.commands.clear();
                assertThatThrownBy(() -> ReactiveBackend.first(other.getDatabase("admin").runCommand(foreign,
                        new Document("ping", 1)))).isInstanceOf(IllegalStateException.class)
                        .hasMessageContaining("ClientSession from same MongoClient");
                assertThat(asked).as("the driver asked for the originator from a com.mongodb.* frame").isTrue();
                assertThat(sent.commands).as("nothing was sent").isEmpty();
            } finally {
                real.close();
            }
        }
    }
}
