package io.github.mprync.sendproof.cosmosdb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.azure.cosmos.CosmosAsyncClient;
import com.azure.cosmos.CosmosAsyncContainer;
import com.azure.cosmos.CosmosAsyncDatabase;
import com.azure.cosmos.CosmosClient;
import com.azure.cosmos.CosmosContainer;
import com.azure.cosmos.CosmosDatabase;
import com.azure.cosmos.CosmosScripts;
import com.azure.cosmos.CosmosStoredProcedure;
import com.azure.cosmos.models.CosmosItemRequestOptions;
import com.azure.cosmos.models.CosmosItemResponse;
import com.azure.cosmos.models.PartitionKey;
import com.azure.cosmos.models.SqlQuerySpec;
import com.fasterxml.jackson.databind.JsonNode;
import io.github.mprync.sendproof.core.PreviewOutcome;
import io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;

/**
 * The Cosmos DB wrappers over mocks of the real SDK classes, which say exactly which calls reached the SDK. The SDK can't
 * be mocked at the wire without a gateway, so the wrappers' contract is the one under test: nothing reaches the SDK
 * before the guard allowed it.
 */
class CosmosStoreTest {
    private static final PartitionKey KEY = new PartitionKey("p1");

    private final CosmosStore store = CosmosStore.builder().name("orders").build();
    private final CosmosContainer sdk = mock(CosmosContainer.class);
    private final GuardedCosmos.Container container = store.container("shop", sdk);

    private static void swallow(Harness.Handler work) {
        try {
            work.run();
        } catch (Exception refused) {
            // The handler catches the refusal and returns normally.
        }
    }

    @SuppressWarnings("unchecked")
    @Test
    void aReadRunsAndIsLoggedWithItsLiteralsReplaced() throws Exception {
        when(sdk.getId()).thenReturn("orders");
        when(sdk.readItem("o-1", KEY, Map.class)).thenReturn(mock(CosmosItemResponse.class));
        JsonNode envelope = Harness.envelope(Harness.preview(store, () -> {
            container.readItem("o-1", KEY, Map.class);
            container.queryItems("SELECT * FROM c WHERE c.status = 'open' AND c.n > 5", null, Map.class);
            container.queryItems(new SqlQuerySpec("SELECT * FROM c WHERE c.id = @id"), null, Map.class);
        }));
        verify(sdk).readItem("o-1", KEY, Map.class);
        JsonNode read = envelope.get("logs").get(0).get("db");
        assertThat(read.get("system").asText()).isEqualTo("cosmosdb");
        assertThat(read.get("operation").asText()).isEqualTo("Read");
        assertThat(read.get("target").asText()).isEqualTo("orders");
        assertThat(read.get("namespace").asText()).isEqualTo("shop");
        assertThat(envelope.get("logs").get(1).get("db").get("statement").asText()).isEqualTo("SELECT * FROM c WHERE c.status = ? AND c.n > ?");
        assertThat(envelope.get("logs").get(2).get("db").get("statement").asText()).isEqualTo("SELECT * FROM c WHERE c.id = @id");
        assertThat(envelope.toString()).doesNotContain("'open'");
    }

    @Test
    void everyWriteIsRefusedBeforeTheSdkIsCalled() throws Exception {
        Map<String, Harness.Handler> writes = new java.util.LinkedHashMap<>();
        writes.put("Create", () -> container.createItem(Map.of("id", "x")));
        writes.put("Upsert", () -> container.upsertItem(Map.of("id", "x")));
        writes.put("Replace", () -> container.replaceItem(Map.of("id", "x"), "x", KEY, new CosmosItemRequestOptions()));
        writes.put("Patch", () -> container.patchItem("x", KEY, com.azure.cosmos.models.CosmosPatchOperations.create().add("/a", 1), Map.class));
        writes.put("Delete", () -> container.deleteItem("x", KEY, new CosmosItemRequestOptions()));
        writes.put("Batch", () -> container.executeCosmosBatch(com.azure.cosmos.models.CosmosBatch.createCosmosBatch(KEY)));
        writes.put("Delete ", () -> container.deleteAllItemsByPartitionKey(KEY, new CosmosItemRequestOptions()));
        for (var write : writes.entrySet()) {
            PreviewOutcome outcome = Harness.preview(store, () -> swallow(write.getValue()));
            assertThat(outcome.blocked()).as(write.getKey()).isTrue();
            assertThat(new String(outcome.problem())).contains("\"store\":\"cosmosdb\"").contains("\"operation\":\"" + write.getKey().trim() + "\"")
                    .contains("Preview unavailable: this operation writes to Cosmos DB");
        }
        verify(sdk, never()).createItem(any());
        verify(sdk, never()).upsertItem(any());
        verify(sdk, never()).executeCosmosBatch(any(com.azure.cosmos.models.CosmosBatch.class));
        verify(sdk, never()).deleteAllItemsByPartitionKey(any(), any());
    }

    @Test
    void theRefusalReachesTheHandlerAsThePreviewException() throws Exception {
        Harness.preview(store, () -> assertThatThrownBy(() -> container.createItem(Map.of("id", "x"))).isInstanceOf(PreviewWriteBlockedException.class));
    }

    @Test
    void aTriggerMakesEvenAReadAWrite() throws Exception {
        var options = new CosmosItemRequestOptions().setPostTriggerInclude(List.of("audit"));
        PreviewOutcome outcome = Harness.preview(store, () -> swallow(() -> container.readItem("o-1", KEY, options, Map.class)));
        assertThat(outcome.blocked()).isTrue();
        assertThat(new String(outcome.problem())).contains("\"operation\":\"Read\"");
        verify(sdk, never()).readItem(any(), any(), any(CosmosItemRequestOptions.class), any());
    }

    @Test
    void aStoredProcedureIsAWriteEvenOneThatOnlyReads() throws Exception {
        var scripts = mock(CosmosScripts.class);
        var procedure = mock(CosmosStoredProcedure.class);
        when(sdk.getScripts()).thenReturn(scripts);
        when(scripts.getStoredProcedure("readOnly")).thenReturn(procedure);
        PreviewOutcome outcome = Harness.preview(store, () -> swallow(() ->
                container.getScripts().getStoredProcedure("readOnly").execute(List.of(), null)));
        assertThat(outcome.blocked()).isTrue();
        assertThat(new String(outcome.problem())).contains("\"operation\":\"ExecuteJavaScript\"");
        verify(procedure, never()).execute(any(), any());
    }

    @Test
    void aHandleDerivedFromTheClientStaysGuarded() throws Exception {
        var rawClient = mock(CosmosClient.class);
        var rawDatabase = mock(CosmosDatabase.class);
        when(rawClient.getDatabase("shop")).thenReturn(rawDatabase);
        when(rawDatabase.getId()).thenReturn("shop");
        when(rawDatabase.getContainer("orders")).thenReturn(sdk);
        var derived = store.client(rawClient).getDatabase("shop").getContainer("orders");
        PreviewOutcome outcome = Harness.preview(store, () -> swallow(() -> derived.upsertItem(Map.of("id", "x"))));
        assertThat(outcome.blocked()).isTrue();
        verify(sdk, never()).upsertItem(any());
    }

    @Test
    void aWriteOutsideAPreviewIsNotBlocked() {
        container.createItem(Map.of("id", "sent"));
        verify(sdk).createItem(any());
    }

    @Test
    void theChecksFailWhenTheHookIsRemoved() throws Exception {
        // Calling the SDK directly, with no wrapper: the write goes through and the Preview confirms.
        PreviewOutcome outcome = Harness.preview(store, () -> sdk.createItem(Map.of("id", "unhooked")));
        assertThat(outcome.blocked()).isFalse();
        verify(sdk).createItem(any());
    }

    @Test
    void theAsyncWrappersRefuseAtCallTimeAndLeaveReadsToTheSdk() throws Exception {
        var rawAsync = mock(CosmosAsyncContainer.class);
        var rawDatabase = mock(CosmosAsyncDatabase.class);
        var rawClient = mock(CosmosAsyncClient.class);
        when(rawClient.getDatabase("shop")).thenReturn(rawDatabase);
        when(rawDatabase.getId()).thenReturn("shop");
        when(rawDatabase.getContainer("orders")).thenReturn(rawAsync);
        when(rawAsync.getId()).thenReturn("orders");
        when(rawAsync.readItem("o-1", KEY, Map.class)).thenReturn(Mono.empty());
        var async = store.asyncClient(rawClient).getDatabase("shop").getContainer("orders");
        PreviewOutcome outcome = Harness.preview(store, () -> {
            async.readItem("o-1", KEY, Map.class).block();
            assertThatThrownBy(() -> async.createItem(Map.of("id", "x")).block()).isInstanceOf(PreviewWriteBlockedException.class);
            assertThatThrownBy(() -> async.executeBulkOperations(reactor.core.publisher.Flux.empty(), null).blockLast())
                    .isInstanceOf(PreviewWriteBlockedException.class);
        });
        assertThat(outcome.blocked()).isTrue();
        verify(rawAsync, never()).createItem(any());
    }

    @Test
    void hostDeclaredReadsPassButNeverATriggeredRequest() throws Exception {
        CosmosStore lenient = CosmosStore.builder().treatAsRead("Create").build();
        var mine = lenient.container("shop", sdk);
        assertThat(Harness.preview(lenient, () -> mine.createItem(Map.of("id", "x"))).confirmed()).isTrue();
        var options = new CosmosItemRequestOptions().setPreTriggerInclude(List.of("stamp"));
        assertThat(Harness.preview(lenient, () -> swallow(() -> mine.createItem(Map.of("id", "y"), options))).blocked()).isTrue();
        assertThat(store.describe().mode()).isEqualTo("guard");
        assertThat(store.describe().system()).isEqualTo("cosmosdb");
    }
}
