package io.github.mprync.sendproof.dynamodb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.mprync.sendproof.core.PreviewOutcome;
import io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException;
import java.net.URI;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.exception.SdkClientException;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.AttributeDefinition;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.BillingMode;
import software.amazon.awssdk.services.dynamodb.model.ExecuteStatementRequest;
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest;
import software.amazon.awssdk.services.dynamodb.model.KeySchemaElement;
import software.amazon.awssdk.services.dynamodb.model.KeyType;
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest;
import software.amazon.awssdk.services.dynamodb.model.ScalarAttributeType;
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest;

/**
 * The DynamoDB hook against DynamoDB Local ({@code docker compose -f tests/conformance/compose.yml up -d --wait
 * dynamodb}). Tests skip, saying so, when the service doesn't answer.
 */
class DynamoDbStoreTest {
    private static final String ENDPOINT = System.getenv().getOrDefault("BENCH_DYNAMODB_SERVER_URL", "http://127.0.0.1:58000");
    private static final String SECRET = "benchDynamoSecretValue";

    private final String table = "sp_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    private DynamoDbStore store;
    private DynamoDbClient raw;
    private DynamoDbClient client;

    private static software.amazon.awssdk.services.dynamodb.DynamoDbClientBuilder builder() {
        return DynamoDbClient.builder().endpointOverride(URI.create(ENDPOINT)).region(Region.US_EAST_1)
                .httpClient(UrlConnectionHttpClient.create())
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create("benchlocal", SECRET)));
    }

    @BeforeEach
    void connect() {
        raw = builder().build();
        try {
            raw.listTables();
        } catch (RuntimeException unreachable) {
            assumeTrue(false, "DynamoDB Local isn't running: docker compose -f tests/conformance/compose.yml up -d --wait dynamodb");
        }
        raw.createTable(request -> request.tableName(table).billingMode(BillingMode.PAY_PER_REQUEST)
                .attributeDefinitions(AttributeDefinition.builder().attributeName("id").attributeType(ScalarAttributeType.S).build())
                .keySchema(KeySchemaElement.builder().attributeName("id").keyType(KeyType.HASH).build()));
        raw.putItem(PutItemRequest.builder().tableName(table).item(Map.of("id", s("seeded"), "status", s("open"),
                "hits", AttributeValue.fromN("3"))).build());
        store = DynamoDbStore.interceptor().name("orders").build();
        client = builder().overrideConfiguration(config -> config.addExecutionInterceptor(store)).build();
    }

    @AfterEach
    void drop() {
        if (raw != null) {
            raw.deleteTable(request -> request.tableName(table));
            raw.close();
        }
    }

    private static AttributeValue s(String value) {
        return AttributeValue.fromS(value);
    }

    private String statusOf(String id) {
        var item = raw.getItem(GetItemRequest.builder().tableName(table).key(Map.of("id", s(id))).consistentRead(true).build());
        return item.hasItem() ? item.item().get("status").s() : null;
    }

    private UpdateItemRequest touch(String id) {
        return UpdateItemRequest.builder().tableName(table).key(Map.of("id", s(id)))
                .updateExpression("ADD hits :one SET #s = if_not_exists(#s, :new)")
                .expressionAttributeNames(Map.of("#s", "status"))
                .expressionAttributeValues(Map.of(":one", AttributeValue.fromN("1"), ":new", s("new")))
                .returnValues("ALL_NEW").build();
    }

    @Test
    void aReadInAPreviewRunsAndIsLoggedWithoutSecrets() throws Exception {
        PreviewOutcome outcome = Harness.preview(() -> {
            var item = client.getItem(GetItemRequest.builder().tableName(table).key(Map.of("id", s("seeded"))).build());
            assertThat(item.item().get("status").s()).isEqualTo("open");
        });
        JsonNode envelope = Harness.envelope(outcome);
        JsonNode entry = envelope.get("logs").get(0);
        assertThat(entry.get("level").asText()).isEqualTo("Db");
        assertThat(entry.get("db").get("system").asText()).isEqualTo("dynamodb");
        assertThat(entry.get("db").get("operation").asText()).isEqualTo("GetItem");
        assertThat(entry.get("db").get("target").asText()).isEqualTo(table);
        assertThat(entry.get("db").get("rowsAffected").asInt()).isEqualTo(1);
        assertThat(envelope.toString()).doesNotContain(SECRET).doesNotContain("AWS4-HMAC-SHA256");
    }

    @Test
    void anUpdateItemIsBlockedBeforeAnyRequestAndTheHandlerCannotHideIt() throws Exception {
        PreviewOutcome outcome = Harness.preview(() -> {
            try {
                client.updateItem(touch("blocked"));
            } catch (RuntimeException swallowed) {
                // The handler catches the refusal and returns normally.
            }
        });
        assertThat(outcome.blocked()).isTrue();
        assertThat(new String(outcome.problem())).contains("\"store\":\"dynamodb\"").contains("\"operation\":\"UpdateItem\"")
                .contains("Preview unavailable: this operation writes to DynamoDB");
        assertThat(statusOf("blocked")).isNull();
    }

    @Test
    void thePreviewsRefusalReachesTheHandlerAsThePreviewException() throws Exception {
        Harness.preview(() -> assertThatThrownBy(() -> client.updateItem(touch("x"))).satisfiesAnyOf(
                error -> assertThat(error).isInstanceOf(PreviewWriteBlockedException.class),
                error -> assertThat(error).hasCauseInstanceOf(PreviewWriteBlockedException.class)));
    }

    @Test
    void aPartiqlUpdateIsAWriteButASelectIsARead() throws Exception {
        PreviewOutcome select = Harness.preview(() -> assertThat(client.executeStatement(ExecuteStatementRequest.builder()
                .statement("SELECT * FROM \"" + table + "\" WHERE id = ?").parameters(s("seeded")).build()).items()).hasSize(1));
        assertThat(select.confirmed()).isTrue();

        PreviewOutcome update = Harness.preview(() -> {
            try {
                client.executeStatement(ExecuteStatementRequest.builder().statement(
                        "UPDATE \"" + table + "\" SET status = 'cancelled' WHERE id = ?").parameters(s("seeded")).build());
            } catch (RuntimeException swallowed) {
                // Refused.
            }
        });
        assertThat(update.blocked()).isTrue();
        assertThat(new String(update.problem())).contains("ExecuteStatement");
        assertThat(statusOf("seeded")).isEqualTo("open");
    }

    @Test
    void inlinePartiqlLiteralsAreReplacedInTheDbEntry() throws Exception {
        JsonNode envelope = Harness.envelope(Harness.preview(() -> client.executeStatement(ExecuteStatementRequest.builder()
                .statement("SELECT * FROM \"" + table + "\" WHERE id = 'seeded' AND hits = 3").build())));
        String statement = envelope.get("logs").get(0).get("db").get("statement").asText();
        assertThat(statement).isEqualTo("SELECT * FROM \"" + table + "\" WHERE id = ? AND hits = ?");
        assertThat(envelope.toString()).doesNotContain("'seeded'");
    }

    @Test
    void outsideAPreviewWritesRunNormally() {
        assertThat(client.updateItem(touch("sent")).attributes().get("hits").n()).isEqualTo("1");
        assertThat(statusOf("sent")).isEqualTo("new");
    }

    @Test
    void aClientBuiltLaterWithoutTheInterceptorIsStillGuarded() throws Exception {
        PreviewOutcome outcome = Harness.preview(() -> {
            // Built inside the handler, with no Sendproof interceptor of its own, sync and async.
            try (DynamoDbClient later = builder().build()) {
                assertThat(later.getItem(GetItemRequest.builder().tableName(table).key(Map.of("id", s("seeded"))).build())
                        .item().get("status").s()).isEqualTo("open");
                assertThatThrownBy(() -> later.updateItem(touch("later"))).satisfiesAnyOf(
                        error -> assertThat(error).isInstanceOf(PreviewWriteBlockedException.class),
                        error -> assertThat(error).hasCauseInstanceOf(PreviewWriteBlockedException.class));
            }
            try (var async = software.amazon.awssdk.services.dynamodb.DynamoDbAsyncClient.builder()
                    .endpointOverride(URI.create(ENDPOINT)).region(Region.US_EAST_1)
                    .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create("benchlocal", SECRET))).build()) {
                assertThatThrownBy(() -> async.updateItem(touch("later-async")).join()).hasRootCauseInstanceOf(PreviewWriteBlockedException.class);
            }
        });
        assertThat(outcome.blocked()).isTrue();
        assertThat(statusOf("later")).isNull();
        assertThat(statusOf("later-async")).isNull();
    }

    @Test
    void theStoresOwnHostDeclaredReadsStillPassOnItsClient() throws Exception {
        var lenient = DynamoDbStore.interceptor().treatAsRead("UpdateItem").build();
        try (DynamoDbClient hooked = builder().overrideConfiguration(config -> config.addExecutionInterceptor(lenient)).build()) {
            PreviewOutcome outcome = Harness.preview(() -> hooked.updateItem(touch("declared")));
            assertThat(outcome.confirmed()).isTrue();
        }
        raw.deleteItem(request -> request.tableName(table).key(Map.of("id", s("declared"))));
    }

    @Test
    void theChecksFailWhenTheHookIsRemoved() throws Exception {
        // With the hook removed (the raw client has no store, and the SDK-wide guard is off) the write is not blocked and
        // the Preview confirms. This is the unhooked case the conformance checks catch.
        UnhookedClientGuard.ENABLED.set(false);
        try {
            PreviewOutcome outcome = Harness.preview(() -> raw.updateItem(touch("unhooked")));
            assertThat(outcome.blocked()).isFalse();
            assertThat(statusOf("unhooked")).isEqualTo("new");
        } finally {
            UnhookedClientGuard.ENABLED.set(true);
        }
    }

    @Test
    void aCredentialNeverReachesTheHook() throws Exception {
        PreviewOutcome outcome = Harness.preview(() -> client.getItem(GetItemRequest.builder().tableName(table)
                .key(Map.of("id", s("seeded"))).build()));
        assertThat(new String(outcome.json())).doesNotContain(SECRET).doesNotContain("benchlocal");
        assertThat(List.of(SdkClientException.class)).isNotEmpty();
    }
}
