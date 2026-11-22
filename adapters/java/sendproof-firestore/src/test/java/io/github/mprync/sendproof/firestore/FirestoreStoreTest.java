package io.github.mprync.sendproof.firestore;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.google.api.gax.rpc.ResponseObserver;
import com.google.api.gax.rpc.StreamController;
import com.google.cloud.NoCredentials;
import com.google.cloud.firestore.Firestore;
import com.google.cloud.firestore.FirestoreOptions;
import com.google.cloud.firestore.spi.v1.FirestoreRpc;
import com.google.firestore.v1.BatchGetDocumentsRequest;
import com.google.firestore.v1.BatchGetDocumentsResponse;
import com.google.firestore.v1.BeginTransactionRequest;
import com.google.firestore.v1.BeginTransactionResponse;
import com.google.firestore.v1.CommitRequest;
import com.google.firestore.v1.CommitResponse;
import com.google.firestore.v1.ExecutePipelineRequest;
import com.google.firestore.v1.RunQueryRequest;
import com.google.firestore.v1.RunQueryResponse;
import com.google.protobuf.ByteString;
import io.github.mprync.sendproof.core.PreviewOutcome;
import io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException;
import io.grpc.MethodDescriptor;
import io.grpc.Server;
import io.grpc.ServerBuilder;
import io.grpc.ServerServiceDefinition;
import io.grpc.protobuf.ProtoUtils;
import io.grpc.stub.ServerCalls;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The Firestore guard through the real client over a local gRPC server that answers just enough, and at the RPC layer for
 * the call types the client doesn't send in these tests ({@code Listen}, the {@code Write} stream, pipelines).
 */
class FirestoreStoreTest {
    private static final String SERVICE = "google.firestore.v1.Firestore";

    private final FirestoreStore store = FirestoreStore.builder().name("orders").build();
    private final List<String> served = Collections.synchronizedList(new ArrayList<>());
    private Server server;
    private Firestore db;

    private static <Q extends com.google.protobuf.Message, R extends com.google.protobuf.Message> MethodDescriptor<Q, R> method(
            String name, MethodDescriptor.MethodType type, Q request, R response) {
        return MethodDescriptor.<Q, R>newBuilder().setType(type).setFullMethodName(SERVICE + "/" + name)
                .setRequestMarshaller(ProtoUtils.marshaller(request)).setResponseMarshaller(ProtoUtils.marshaller(response)).build();
    }

    @BeforeEach
    void start() throws Exception {
        ServerServiceDefinition service = ServerServiceDefinition.builder(SERVICE)
                .addMethod(method("BatchGetDocuments", MethodDescriptor.MethodType.SERVER_STREAMING,
                        BatchGetDocumentsRequest.getDefaultInstance(), BatchGetDocumentsResponse.getDefaultInstance()),
                        ServerCalls.<BatchGetDocumentsRequest, BatchGetDocumentsResponse>asyncServerStreamingCall((request, out) -> {
                            served.add("BatchGetDocuments");
                            out.onNext(BatchGetDocumentsResponse.newBuilder().setMissing(request.getDocuments(0)).build());
                            out.onCompleted();
                        }))
                .addMethod(method("RunQuery", MethodDescriptor.MethodType.SERVER_STREAMING,
                        RunQueryRequest.getDefaultInstance(), RunQueryResponse.getDefaultInstance()),
                        ServerCalls.<RunQueryRequest, RunQueryResponse>asyncServerStreamingCall((request, out) -> {
                            served.add("RunQuery");
                            out.onNext(RunQueryResponse.getDefaultInstance());
                            out.onCompleted();
                        }))
                .addMethod(method("BeginTransaction", MethodDescriptor.MethodType.UNARY,
                        BeginTransactionRequest.getDefaultInstance(), BeginTransactionResponse.getDefaultInstance()),
                        ServerCalls.<BeginTransactionRequest, BeginTransactionResponse>asyncUnaryCall((request, out) -> {
                            served.add("BeginTransaction");
                            out.onNext(BeginTransactionResponse.newBuilder().setTransaction(ByteString.copyFromUtf8("tx")).build());
                            out.onCompleted();
                        }))
                .addMethod(method("BatchWrite", MethodDescriptor.MethodType.UNARY,
                        com.google.firestore.v1.BatchWriteRequest.getDefaultInstance(), com.google.firestore.v1.BatchWriteResponse.getDefaultInstance()),
                        ServerCalls.<com.google.firestore.v1.BatchWriteRequest, com.google.firestore.v1.BatchWriteResponse>asyncUnaryCall((request, out) -> {
                            served.add("BatchWrite");
                            var response = com.google.firestore.v1.BatchWriteResponse.newBuilder();
                            for (int i = 0; i < request.getWritesCount(); i++) {
                                response.addWriteResults(com.google.firestore.v1.WriteResult.getDefaultInstance())
                                        .addStatus(com.google.rpc.Status.getDefaultInstance());
                            }
                            out.onNext(response.build());
                            out.onCompleted();
                        }))
                .addMethod(method("Commit", MethodDescriptor.MethodType.UNARY,
                        CommitRequest.getDefaultInstance(), CommitResponse.getDefaultInstance()),
                        ServerCalls.<CommitRequest, CommitResponse>asyncUnaryCall((request, out) -> {
                            served.add("Commit");
                            out.onNext(CommitResponse.getDefaultInstance());
                            out.onCompleted();
                        }))
                .build();
        server = ServerBuilder.forPort(0).addService(service).build().start();
        // A localhost host with no credentials is the client's own emulator setup: a plaintext channel to this server.
        db = store.firestore(FirestoreOptions.newBuilder().setProjectId("bench").setCredentials(NoCredentials.getInstance())
                .setHost("localhost:" + server.getPort()));
    }

    @AfterEach
    void stop() throws Exception {
        db.close();
        server.shutdownNow();
    }

    private static void swallow(Harness.Handler work) {
        try {
            work.run();
        } catch (Exception refused) {
            // The handler catches the refusal and returns normally.
        }
    }

    @Test
    void aGetAndAQueryRunAndAreLoggedWithoutTheirPaths() throws Exception {
        JsonNode envelope = Harness.envelope(Harness.preview(store, () -> {
            assertThat(db.document("orders/o-1").get().get().exists()).isFalse();
            db.collection("orders").whereEqualTo("status", "secret-status").get().get();
        }));
        assertThat(served).containsExactly("BatchGetDocuments", "RunQuery");
        JsonNode get = envelope.get("logs").get(0).get("db");
        assertThat(get.get("system").asText()).isEqualTo("firestore");
        assertThat(get.get("operation").asText()).isEqualTo("BatchGetDocuments");
        assertThat(get.get("target").asText()).isEqualTo("orders");
        assertThat(get.get("namespace").asText()).isEqualTo("(default)");
        JsonNode query = envelope.get("logs").get(1).get("db");
        assertThat(query.get("operation").asText()).isEqualTo("RunQuery");
        assertThat(query.get("target").asText()).isEqualTo("orders");
        assertThat(envelope.toString()).doesNotContain("o-1").doesNotContain("secret-status");
    }

    @Test
    void aSetIsRefusedBeforeAnythingIsSentAndTheHandlerCannotHideIt() throws Exception {
        PreviewOutcome outcome = Harness.preview(store, () -> swallow(() -> db.document("orders/o-1").set(Map.of("status", "new")).get()));
        assertThat(outcome.blocked()).isTrue();
        assertThat(new String(outcome.problem())).contains("\"store\":\"firestore\"").contains("\"operation\":\"Commit\"")
                .contains("Preview unavailable: this operation writes to Firestore");
        assertThat(served).isEmpty();
    }

    @Test
    void theRefusalReachesTheHandlerAsThePreviewException() throws Exception {
        Harness.preview(store, () -> assertThatThrownBy(() -> db.batch().delete(db.document("orders/o-1")).commit().get())
                .satisfiesAnyOf(error -> assertThat(error).isInstanceOf(PreviewWriteBlockedException.class),
                        error -> assertThat(error).hasRootCauseInstanceOf(PreviewWriteBlockedException.class)));
        assertThat(served).isEmpty();
    }

    @Test
    void aTransactionThatWritesReadsFirstAndIsRefusedAtItsCommit() throws Exception {
        PreviewOutcome outcome = Harness.preview(store, () -> swallow(() -> db.runTransaction(transaction -> {
            transaction.get(db.document("orders/o-1")).get();
            transaction.set(db.document("orders/o-1"), Map.of("status", "new"));
            return null;
        }).get()));
        assertThat(outcome.blocked()).isTrue();
        assertThat(served).doesNotContain("Commit");
    }

    @Test
    void aWriteOutsideAPreviewIsNotBlocked() throws Exception {
        db.document("orders/sent").set(Map.of("status", "new")).get();
        assertThat(served).containsExactly("Commit");
    }

    @Test
    void aClientDerivedFromTheHookedOptionsStaysGuarded() throws Exception {
        Firestore derived = db.getOptions().toBuilder().build().getService();
        try {
            PreviewOutcome outcome = Harness.preview(store, () -> swallow(() -> derived.document("orders/o-2").set(Map.of("a", 1)).get()));
            assertThat(outcome.blocked()).isTrue();
        } finally {
            derived.close();
        }
        assertThat(served).isEmpty();
    }

    @Test
    void theWriteStreamPipelinesAndUnknownCallsAreRefusedAndListenIsARead() throws Exception {
        var fake = new FakeRpc();
        FirestoreRpc guarded = store.rpc(fake.rpc);
        PreviewOutcome outcome = Harness.preview(store, () -> {
            guarded.listenCallable().internalCall(null, null, null);
            assertThatThrownBy(() -> guarded.executePipelineCallable().call(ExecutePipelineRequest.getDefaultInstance(), noObserver()))
                    .isInstanceOf(PreviewWriteBlockedException.class);
        });
        assertThat(outcome.blocked()).isTrue();
        assertThat(new String(outcome.problem())).contains("\"operation\":\"ExecutePipeline\"");
        assertThat(fake.reached).containsExactly("Listen");
    }

    @Test
    void aBackgroundWriteWithNoRequestIsRefusedBeforeItIsSentAndBlocksTheOpenPreviewUnlessDetached() throws Exception {
        var fake = new FakeRpc();
        FirestoreRpc guarded = store.rpc(fake.rpc);
        var commit = CommitRequest.newBuilder().addWrites(com.google.firestore.v1.Write.getDefaultInstance()).build();
        var pool = java.util.concurrent.Executors.newSingleThreadExecutor();
        try {
            PreviewOutcome outcome = Harness.preview(store, () -> assertThatThrownBy(() ->
                    pool.submit(() -> guarded.commitCallable().futureCall(commit)).get()).hasRootCauseInstanceOf(PreviewWriteBlockedException.class));
            assertThat(outcome.blocked()).isTrue();
            assertThat(fake.reached).isEmpty();
            PreviewOutcome detached = Harness.preview(store, () -> pool.submit(() -> io.github.mprync.sendproof.core.CaptureContext
                    .detached(() -> guarded.commitCallable().futureCall(commit))).get());
            assertThat(detached.confirmed()).isTrue();
            assertThat(fake.reached).containsExactly("Commit");
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void aTaskTheHandlerStartedWritesAfterTheResponseAndIsRefused() throws Exception {
        var fake = new FakeRpc();
        FirestoreRpc guarded = store.rpc(fake.rpc);
        var commit = CommitRequest.newBuilder().addWrites(com.google.firestore.v1.Write.getDefaultInstance()).build();
        var later = new java.util.concurrent.CompletableFuture<Throwable>();
        // The task runs on the client's executor, which carries the Preview's context, long after the Preview ended.
        var pool = new java.util.concurrent.ScheduledThreadPoolExecutor(1);
        var executor = new PropagatingExecutor(pool);
        try {
            PreviewOutcome outcome = Harness.preview(store, () -> executor.schedule(() -> {
                try {
                    guarded.commitCallable().futureCall(commit);
                    later.complete(null);
                } catch (Throwable refused) {
                    later.complete(refused);
                }
            }, 500, java.util.concurrent.TimeUnit.MILLISECONDS));
            assertThat(outcome.confirmed()).isTrue();
            assertThat(later.get(10, java.util.concurrent.TimeUnit.SECONDS)).isInstanceOf(PreviewWriteBlockedException.class);
            assertThat(fake.reached).isEmpty();
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void aBulkWriterRefusesAtQueueTimeOnTheCallersThreadSoNothingRetriesOrHangs() throws Exception {
        PreviewOutcome outcome = Harness.preview(store, () -> {
            var bulk = store.bulkWriter(db);
            assertThatThrownBy(() -> bulk.set(db.document("orders/o-1"), Map.of("status", "new"))).isInstanceOf(PreviewWriteBlockedException.class);
            // Nothing was queued, so flush and close return at once.
            bulk.flush().get(10, java.util.concurrent.TimeUnit.SECONDS);
            bulk.close();
        });
        assertThat(outcome.blocked()).isTrue();
        assertThat(new String(outcome.problem())).contains("\"operation\":\"BatchWrite\"");
        assertThat(served).isEmpty();
        // Outside a Preview the writer queues and sends as usual (this server doesn't implement BatchWrite, so only the queueing is shown).
        var bulk = store.bulkWriter(db);
        bulk.set(db.document("orders/sent"), Map.of("status", "new"));
    }

    /**
     * Runs {@code work} on another thread, under the caller's capture, and fails the test, rather than hanging it, when it
     * doesn't return in time.
     */
    private static void returnsWithin(int seconds, Harness.Handler work) throws Exception {
        var pool = new PropagatingExecutor(java.util.concurrent.Executors.newSingleThreadScheduledExecutor());
        try {
            pool.submit(() -> {
                work.run();
                return null;
            }).get(seconds, java.util.concurrent.TimeUnit.SECONDS);
        } catch (java.util.concurrent.TimeoutException hung) {
            throw new AssertionError("did not return within " + seconds + " s", hung);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void aBulkWriterFromTheGuardedClientIsRefusedInAPreviewAndNeverHangs() throws Exception {
        // A BulkWriter made before the Preview, from the guarded client itself: its queued write is refused when it is
        // sent, and that refusal fails the write instead of leaving flush and close waiting forever.
        var early = db.bulkWriter();
        var failed = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        PreviewOutcome outcome = Harness.preview(store, () -> {
            var write = early.set(db.document("orders/o-1"), Map.of("status", "new"));
            returnsWithin(10, early::close);
            try {
                write.get(10, java.util.concurrent.TimeUnit.SECONDS);
            } catch (java.util.concurrent.ExecutionException refused) {
                failed.set(refused.getCause());
            }
        });
        assertThat(failed.get()).isNotNull();
        assertThat(outcome.blocked()).isTrue();
        assertThat(new String(outcome.problem())).contains("\"operation\":\"BatchWrite\"");
        assertThat(served).isEmpty();
    }

    @Test
    void everyBulkWriterTheGuardedClientHandsOutInAPreviewIsRefusedWhenItIsMade() throws Exception {
        for (Harness.Handler made : List.<Harness.Handler>of(db::bulkWriter,
                () -> db.bulkWriter(com.google.cloud.firestore.BulkWriterOptions.builder().setThrottlingEnabled(false).build()),
                () -> db.recursiveDelete(db.document("orders/o-1")))) {
            PreviewOutcome outcome = Harness.preview(store, () -> assertThatThrownBy(made::run).isInstanceOf(PreviewWriteBlockedException.class));
            assertThat(outcome.blocked()).isTrue();
        }
        assertThat(served).isEmpty();
        // Outside a Preview the client hands them out as usual.
        db.bulkWriter().close();
    }

    @Test
    void aPreviewThatFlushesASharedGuardedWriterSendsTheWritesOtherRequestsQueued() throws Exception {
        var shared = store.bulkWriter(db);
        // Queued by an ordinary request (allowed when it was queued), not yet sent.
        var write = shared.set(db.document("orders/sent"), Map.of("status", "new"));
        PreviewOutcome outcome = Harness.preview(store, () -> shared.flush().get(10, java.util.concurrent.TimeUnit.SECONDS));
        assertThat(outcome.blocked()).isFalse();
        write.get(10, java.util.concurrent.TimeUnit.SECONDS);
        assertThat(served).containsExactly("BatchWrite");
        shared.close();
    }

    @Test
    void anInternalBulkWriterRefusedAtSendTimeDoesNotHang() throws Exception {
        // recursiveDelete through a client derived from the guarded options runs the library's own BulkWriter.
        Firestore derived = db.getOptions().toBuilder().build().getService();
        try {
            PreviewOutcome outcome = Harness.preview(store, () -> returnsWithin(10, () ->
                    swallow(() -> derived.recursiveDelete(db.document("orders/o-1")).get(10, java.util.concurrent.TimeUnit.SECONDS))));
            assertThat(outcome.blocked()).isTrue();
        } finally {
            derived.close();
        }
    }

    @Test
    void anEmptyCommitEndsATransactionThatOnlyReadAndIsAllowed() throws Exception {
        var fake = new FakeRpc();
        FirestoreRpc guarded = store.rpc(fake.rpc);
        PreviewOutcome outcome = Harness.preview(store, () ->
                guarded.commitCallable().futureCall(CommitRequest.newBuilder().setTransaction(ByteString.copyFromUtf8("tx")).build()));
        assertThat(outcome.confirmed()).isTrue();
        assertThat(fake.reached).containsExactly("Commit");
    }

    @Test
    void aLayerIsNotWrappedTwiceAndHostDeclaredReadsPassButNeverACommitThatWrites() throws Exception {
        var fake = new FakeRpc();
        FirestoreRpc guarded = store.rpc(fake.rpc);
        assertThat(store.rpc(guarded)).isSameAs(guarded);
        assertThat(FirestoreStore.isGuarded(guarded)).isTrue();
        assertThat(FirestoreStore.isGuarded(fake.rpc)).isFalse();

        FirestoreStore lenient = FirestoreStore.builder().treatAsRead("ExecutePipeline", "Commit").build();
        FirestoreRpc mine = lenient.rpc(fake.rpc);
        assertThat(Harness.preview(lenient, () -> mine.executePipelineCallable().call(ExecutePipelineRequest.getDefaultInstance(), noObserver()))
                .confirmed()).isTrue();
        PreviewOutcome commit = Harness.preview(lenient, () -> assertThatThrownBy(() -> mine.commitCallable().futureCall(
                CommitRequest.newBuilder().addWrites(com.google.firestore.v1.Write.getDefaultInstance()).build()))
                .isInstanceOf(PreviewWriteBlockedException.class));
        assertThat(commit.blocked()).isTrue();
        assertThat(store.describe().mode()).isEqualTo("guard");
    }

    @SuppressWarnings("unchecked")
    private static <R> ResponseObserver<R> noObserver() {
        return new ResponseObserver<>() {
            @Override
            public void onStart(StreamController controller) {
            }

            @Override
            public void onResponse(R response) {
            }

            @Override
            public void onError(Throwable failure) {
            }

            @Override
            public void onComplete() {
            }
        };
    }
}
