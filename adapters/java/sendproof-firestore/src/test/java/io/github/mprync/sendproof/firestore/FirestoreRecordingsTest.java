package io.github.mprync.sendproof.firestore;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.google.api.gax.rpc.ResponseObserver;
import com.google.api.gax.rpc.StreamController;
import com.google.cloud.firestore.spi.v1.FirestoreRpc;
import com.google.firestore.v1.BatchGetDocumentsRequest;
import com.google.firestore.v1.BatchWriteRequest;
import com.google.firestore.v1.CommitRequest;
import com.google.firestore.v1.ListCollectionIdsRequest;
import com.google.firestore.v1.ListDocumentsRequest;
import com.google.firestore.v1.RunAggregationQueryRequest;
import com.google.firestore.v1.RunQueryRequest;
import com.google.protobuf.Message;
import com.google.protobuf.util.JsonFormat;
import io.github.mprync.sendproof.core.Json;
import io.github.mprync.sendproof.core.PreviewOutcome;
import io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;

/**
 * Replays the requests a real Firestore SDK sent ({@code spec/data-stores/recordings/firestore.json}) through the guarded
 * RPC layer over a fake one, as {@code recordings/README.md} describes: reads and session calls reach it unchanged and
 * are logged with every literal replaced; writes are refused before anything is sent and mark the Preview blocked; outside
 * a Preview everything reaches it; and with the hook removed the write assertions fail.
 */
class FirestoreRecordingsTest {
    private static final Map<String, Supplier<Message.Builder>> REQUESTS = Map.of(
            "BatchGetDocuments", BatchGetDocumentsRequest::newBuilder, "RunQuery", RunQueryRequest::newBuilder,
            "RunAggregationQuery", RunAggregationQueryRequest::newBuilder, "ListCollectionIds", ListCollectionIdsRequest::newBuilder,
            "Commit", CommitRequest::newBuilder, "BatchWrite", BatchWriteRequest::newBuilder, "ListDocuments", ListDocumentsRequest::newBuilder);

    private final FirestoreStore store = FirestoreStore.builder().name("orders").build();

    /** One recorded request: the RPC, its parsed message, and what the table says it is. */
    private record Recorded(String name, String bare, Message message, String kind, String operation) {
    }

    private static List<Recorded> recordings() throws IOException {
        JsonNode file = Json.MAPPER.readTree(Files.readString(
                Path.of(System.getProperty("sendproof.spec.dir"), "data-stores", "recordings", "firestore.json")));
        var all = new ArrayList<Recorded>();
        for (JsonNode recording : file.get("recordings")) {
            for (JsonNode request : recording.get("requests")) {
                String rpc = request.get("rpc").asText();
                String bare = rpc.substring(rpc.lastIndexOf('/') + 1);
                Message.Builder builder = REQUESTS.get(bare).get();
                if (request.get("rest").has("body")) {
                    JsonFormat.parser().ignoringUnknownFields().merge(request.get("rest").get("body").toString(), builder);
                }
                all.add(new Recorded(recording.get("name").asText(), bare, builder.build(),
                        request.get("expect").get("kind").asText(), request.get("expect").get("operation").asText()));
            }
        }
        return all;
    }

    private static ResponseObserver<Object> observer() {
        return new ResponseObserver<>() {
            @Override
            public void onStart(StreamController controller) {
            }

            @Override
            public void onResponse(Object response) {
            }

            @Override
            public void onError(Throwable failure) {
            }

            @Override
            public void onComplete() {
            }
        };
    }

    /** Sends the recorded request through the callable the SDK would have used for it. */
    @SuppressWarnings({"unchecked", "rawtypes"})
    private static void replay(FirestoreRpc rpc, Recorded r) {
        switch (r.bare()) {
            case "Commit" -> rpc.commitCallable().futureCall((CommitRequest) r.message());
            case "BatchWrite" -> rpc.batchWriteCallable().futureCall((BatchWriteRequest) r.message());
            case "BatchGetDocuments" -> rpc.batchGetDocumentsCallable().call((BatchGetDocumentsRequest) r.message(), (ResponseObserver) observer());
            case "RunQuery" -> rpc.runQueryCallable().call((RunQueryRequest) r.message(), (ResponseObserver) observer());
            case "RunAggregationQuery" -> rpc.runAggregationQueryCallable().call((RunAggregationQueryRequest) r.message(), (ResponseObserver) observer());
            case "ListCollectionIds" -> rpc.listCollectionIdsPagedCallable().futureCall((ListCollectionIdsRequest) r.message());
            case "ListDocuments" -> rpc.listDocumentsPagedCallable().futureCall((ListDocumentsRequest) r.message());
            default -> throw new IllegalArgumentException("No callable for " + r.bare());
        }
    }

    @Test
    void theRecordingsAreThere() throws IOException {
        List<Recorded> all = recordings();
        assertThat(all).extracting(Recorded::kind).contains("read", "write", "session");
        assertThat(all).hasSizeGreaterThanOrEqualTo(15);
    }

    @Test
    void readsAndSessionCallsReachTheRpcUnchangedAndAreLoggedWithoutLiterals() throws Exception {
        var fake = new FakeRpc();
        FirestoreRpc guarded = store.rpc(fake.rpc);
        List<Recorded> allowed = recordings().stream().filter(r -> !r.kind().equals("write")).toList();
        var envelope = Harness.envelope(Harness.preview(store, () -> allowed.forEach(r -> replay(guarded, r))));
        assertThat(fake.messages).containsExactlyElementsOf(allowed.stream().map(Recorded::message).toList());
        var logged = new ArrayList<String>();
        for (JsonNode entry : envelope.get("logs")) {
            if (entry.get("level").asText().equals("Db")) {
                assertThat(entry.get("db").get("system").asText()).isEqualTo("firestore");
                logged.add(entry.get("db").get("operation").asText());
            }
        }
        // Session calls (and a Commit with no writes) are never logged.
        assertThat(logged).containsExactlyElementsOf(allowed.stream().filter(r -> r.kind().equals("read")).map(Recorded::operation).toList());
        assertThat(envelope.toString()).doesNotContain("projects/bench").doesNotContain("o-1");
    }

    @Test
    void writesAreRefusedBeforeAnythingIsSentAndMarkThePreviewBlocked() throws Exception {
        for (Recorded write : recordings().stream().filter(r -> r.kind().equals("write")).toList()) {
            var fake = new FakeRpc();
            FirestoreRpc guarded = store.rpc(fake.rpc);
            PreviewOutcome outcome = Harness.preview(store, () -> assertThatThrownBy(() -> replay(guarded, write))
                    .as(write.name()).isInstanceOfSatisfying(PreviewWriteBlockedException.class, refused -> {
                        assertThat(refused.store()).isEqualTo("firestore");
                        assertThat(refused.operation()).isEqualTo(write.operation());
                    }));
            assertThat(outcome.blocked()).as(write.name()).isTrue();
            assertThat(new String(outcome.problem())).contains("\"store\":\"firestore\"").contains("\"operation\":\"" + write.operation() + "\"")
                    .contains("Preview unavailable: this operation writes to Firestore");
            assertThat(fake.reached).as(write.name() + " must not reach the transport").isEmpty();
        }
    }

    @Test
    void aTransactionThatWritesIsRefusedAtItsCommitAfterItsReadRan() throws Exception {
        var fake = new FakeRpc();
        FirestoreRpc guarded = store.rpc(fake.rpc);
        List<Recorded> transaction = recordings().stream().filter(r -> r.name().equals("run a read-write transaction that writes")).toList();
        PreviewOutcome outcome = Harness.preview(store, () -> {
            replay(guarded, transaction.get(0));
            assertThatThrownBy(() -> replay(guarded, transaction.get(1))).isInstanceOf(PreviewWriteBlockedException.class);
        });
        assertThat(outcome.blocked()).isTrue();
        assertThat(fake.reached).containsExactly("BatchGetDocuments");
    }

    @Test
    void outsideAPreviewEveryRecordedRequestReachesTheRpcWritesIncluded() throws Exception {
        var fake = new FakeRpc();
        FirestoreRpc guarded = store.rpc(fake.rpc);
        List<Recorded> all = recordings();
        all.forEach(r -> replay(guarded, r));
        assertThat(fake.messages).containsExactlyElementsOf(all.stream().map(Recorded::message).toList());
    }

    @Test
    void withTheHookRemovedTheWriteAssertionsFail() throws Exception {
        // The same replay straight on the fake RPC layer: writes reach it and the Preview confirms. A binding whose hook
        // were missing would fail the assertions of writesAreRefusedBeforeAnythingIsSentAndMarkThePreviewBlocked.
        for (Recorded write : recordings().stream().filter(r -> r.kind().equals("write")).toList()) {
            var fake = new FakeRpc();
            PreviewOutcome outcome = Harness.preview(store, () -> replay(fake.rpc, write));
            assertThat(outcome.blocked()).as(write.name()).isFalse();
            assertThat(fake.messages).as(write.name()).containsExactly(write.message());
        }
    }
}
