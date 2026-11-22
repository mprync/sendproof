package io.github.mprync.sendproof.cosmosdb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.mprync.sendproof.core.Json;
import io.github.mprync.sendproof.core.PreviewOutcome;
import io.github.mprync.sendproof.core.stores.GuardOnlyStore.Observation;
import io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException;
import io.github.mprync.sendproof.core.stores.StoreClassifier;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Replays the requests a real Cosmos DB SDK sent ({@code spec/data-stores/recordings/cosmosdb.json}) through the guard, as
 * {@code recordings/README.md} describes. The Java SDK's hook is the operation (the wrappers pass the SDK's operation type
 * and whether the options name a trigger), so each recorded request is replayed from its {@code sdk} entry, with the
 * trigger headers of its {@code http} entry, and the {@code http} expectations are checked against the table's
 * {@code fromRequest} rules. The fake transport is a list that only an allowed request reaches.
 */
class CosmosRecordingsTest {
    private final CosmosStore store = CosmosStore.builder().name("orders").build();

    /** One recorded request. */
    private record Recorded(String name, String operationType, boolean triggers, String statement, String method, String path,
                            Map<String, String> headers, String kind, String operation, String httpKind, String httpOperation) {
    }

    private static List<Recorded> recordings() throws IOException {
        JsonNode file = Json.MAPPER.readTree(Files.readString(
                Path.of(System.getProperty("sendproof.spec.dir"), "data-stores", "recordings", "cosmosdb.json")));
        var all = new ArrayList<Recorded>();
        for (JsonNode recording : file.get("recordings")) {
            for (JsonNode request : recording.get("requests")) {
                var headers = new LinkedHashMap<String, String>();
                request.get("http").get("headers").fields().forEachRemaining(entry -> headers.put(entry.getKey(), entry.getValue().asText()));
                boolean triggers = headers.keySet().stream().map(String::toLowerCase).anyMatch(
                        name -> name.equals("x-ms-documentdb-pre-trigger-include") || name.equals("x-ms-documentdb-post-trigger-include"));
                JsonNode body = request.get("http").get("body");
                String statement = body != null && body.has("query") ? body.get("query").asText() : null;
                JsonNode expect = request.get("expect");
                all.add(new Recorded(recording.get("name").asText(), request.get("sdk").get("operationType").asText(), triggers, statement,
                        request.get("http").get("method").asText(), request.get("http").get("path").asText(), headers,
                        expect.get("sdk").get("kind").asText(), expect.get("sdk").get("operation").asText(),
                        expect.get("http").get("kind").asText(), expect.get("http").get("operation").asText()));
            }
        }
        return all;
    }

    /** What the wrappers do for one operation: guard, then "send" (add to {@code transport}), then complete. */
    private void replay(Recorded r, List<String> transport) {
        Observation call = store.guard(r.operationType(), r.triggers(), "shop", "orders", r.statement());
        transport.add(r.name());
        call.complete(null, null);
    }

    @Test
    void theRecordingsAreThere() throws IOException {
        List<Recorded> all = recordings();
        assertThat(all).extracting(Recorded::kind).contains("read", "write");
        assertThat(all).hasSizeGreaterThanOrEqualTo(19);
    }

    @Test
    void theHttpExpectationsMatchTheTablesFromRequestRules() throws IOException {
        for (Recorded r : recordings()) {
            var result = StoreClassifier.cosmosRequest(r.method(), r.path(), r.headers(), null);
            assertThat(result.kind().name().toLowerCase()).as(r.name()).isEqualTo(r.httpKind());
            assertThat(result.operation()).as(r.name()).isEqualTo(r.httpOperation());
        }
    }

    @Test
    void readsReachTheTransportAndAreLoggedWithoutValues() throws Exception {
        List<Recorded> reads = recordings().stream().filter(r -> r.kind().equals("read")).toList();
        var transport = Collections.synchronizedList(new ArrayList<String>());
        var envelope = Harness.envelope(Harness.preview(store, () -> reads.forEach(r -> replay(r, transport))));
        assertThat(transport).hasSize(reads.size());
        var logged = new ArrayList<String>();
        for (JsonNode entry : envelope.get("logs")) {
            if (entry.get("level").asText().equals("Db")) {
                assertThat(entry.get("db").get("system").asText()).isEqualTo("cosmosdb");
                assertThat(entry.get("db").get("target").asText()).isEqualTo("orders");
                assertThat(entry.get("db").get("namespace").asText()).isEqualTo("shop");
                logged.add(entry.get("db").get("operation").asText());
            }
        }
        assertThat(logged).containsExactlyElementsOf(reads.stream().map(Recorded::operation).toList());
        assertThat(envelope.toString()).contains("c.status = @status").doesNotContain("\"open\"");
    }

    @Test
    void writesAreRefusedBeforeAnythingIsSentAndMarkThePreviewBlocked() throws Exception {
        List<Recorded> writes = recordings().stream().filter(r -> r.kind().equals("write")).toList();
        // Including a read that names a post-trigger, which is a write whatever its operation.
        assertThat(writes).extracting(Recorded::operation).contains("Create", "Upsert", "Replace", "Patch", "Delete", "Batch", "Execute",
                "Read");
        for (Recorded write : writes) {
            var transport = Collections.synchronizedList(new ArrayList<String>());
            PreviewOutcome outcome = Harness.preview(store, () -> assertThatThrownBy(() -> replay(write, transport))
                    .as(write.name()).isInstanceOfSatisfying(PreviewWriteBlockedException.class, refused -> {
                        assertThat(refused.store()).isEqualTo("cosmosdb");
                        assertThat(refused.operation()).isEqualTo(write.operation());
                    }));
            assertThat(outcome.blocked()).as(write.name()).isTrue();
            assertThat(new String(outcome.problem())).contains("\"store\":\"cosmosdb\"").contains("\"operation\":\"" + write.operation() + "\"")
                    .contains("Preview unavailable: this operation writes to Cosmos DB");
            assertThat(transport).as(write.name() + " must not reach the transport").isEmpty();
        }
    }

    @Test
    void outsideAPreviewEveryRecordedRequestReachesTheTransportWritesIncluded() throws Exception {
        List<Recorded> all = recordings();
        var transport = new ArrayList<String>();
        all.forEach(r -> replay(r, transport));
        assertThat(transport).hasSize(all.size());
    }

    @Test
    void withTheHookRemovedTheWriteAssertionsFail() throws Exception {
        // With no guard in front of the transport a write reaches it and the Preview confirms. A binding whose hook were
        // missing would fail the assertions of writesAreRefusedBeforeAnythingIsSentAndMarkThePreviewBlocked.
        for (Recorded write : recordings().stream().filter(r -> r.kind().equals("write")).toList()) {
            var transport = new ArrayList<String>();
            PreviewOutcome outcome = Harness.preview(store, () -> transport.add(write.name()));
            assertThat(outcome.blocked()).as(write.name()).isFalse();
            assertThat(transport).as(write.name()).hasSize(1);
        }
    }
}
