package io.github.mprync.sendproof.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.DataStore;
import io.github.mprync.sendproof.core.DbEntry;
import io.github.mprync.sendproof.core.stores.CommandKind;
import io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Data stores in the Spring adapter, with a fake guard-only store and no SQL provider at all: the blocked Preview, the
 * 409 response, the {@code preview: false} mark, discovery, and a Preview that runs when only stores are hooked.
 */
@SpringBootTest(classes = StoresTest.App.class, properties = {"sendproof.enabled=true", "sendproof.environment=Development",
        "sendproof.trace.retention=5s"})
@AutoConfigureMockMvc
class StoresTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    /** A store that only guards, standing in for Redis: each command is guarded, logged and then "sent". */
    static final class FakeStore implements DataStore {
        final List<String> sent = new ArrayList<>();

        @Override
        public String system() {
            return "redis";
        }

        @Override
        public Description describe() {
            return new Description("redis", "cache", "guard", null);
        }

        void command(String name, CommandKind kind) {
            StoreGuard.guard("redis", name, kind, null);
            var capture = CaptureContext.current();
            if (capture != null) {
                capture.db(DbEntry.of("redis", name).withTarget("k"));
            }
            if (kind == CommandKind.WRITE) {
                sent.add(name);
            }
        }
    }

    @RestController
    @RequestMapping("/things")
    static class Things {
        private final FakeStore store;

        Things(FakeStore store) {
            this.store = store;
        }

        @SendproofPreview
        @GetMapping("/read")
        Map<String, Integer> read() {
            store.command("GET", CommandKind.READ);
            return Map.of("value", 5);
        }

        @SendproofPreview
        @PostMapping("/write")
        Map<String, Integer> write() {
            store.command("INCR", CommandKind.WRITE);
            return Map.of("value", 1);
        }

        /** The handler catches the refusal and returns 200 anyway. */
        @SendproofPreview
        @PostMapping("/swallow")
        Map<String, Integer> swallow() {
            try {
                store.command("GETDEL", CommandKind.WRITE);
            } catch (PreviewWriteBlockedException refused) {
                // Swallowed.
            }
            return Map.of("value", 1);
        }

        @SendproofPreview(enabled = false, stores = "redis")
        @DeleteMapping("/clear")
        void clear() {
            store.command("DEL", CommandKind.WRITE);
        }

        @SendproofPreview(enabled = false, reason = "Sends a message that can't be recalled")
        @PostMapping("/announce")
        void announce() {
        }
    }

    @Configuration
    @EnableAutoConfiguration
    static class App {
        @Bean
        FakeStore store() {
            return new FakeStore();
        }

        @Bean
        Things things(FakeStore store) {
            return new Things(store);
        }
    }

    @Autowired
    MockMvc mvc;
    @Autowired
    FakeStore store;

    @BeforeEach
    void reset() {
        store.sent.clear();
    }

    private MvcResult preview(org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder builder) throws Exception {
        return mvc.perform(builder.header("Prefer", "tx=rollback")).andReturn();
    }

    private static JsonNode body(MvcResult result) throws Exception {
        return JSON.readTree(result.getResponse().getContentAsByteArray());
    }

    @Test
    void aPreviewRunsWithoutASqlProviderWhenOnlyStoresAreHooked() throws Exception {
        MvcResult result = preview(get("/sendproof/_preview/things/read"));
        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        assertThat(result.getResponse().getHeader("Preference-Applied")).isEqualTo("tx=rollback");
        JsonNode envelope = body(result);
        assertThat(envelope.get("body").get("value").asInt()).isEqualTo(5);
        JsonNode entry = envelope.get("logs").get(0);
        assertThat(entry.get("level").asText()).isEqualTo("Db");
        assertThat(entry.get("db").get("system").asText()).isEqualTo("redis");
        assertThat(entry.get("db").get("operation").asText()).isEqualTo("GET");
    }

    @Test
    void aBlockedPreviewAnswers409WithAProblemBody() throws Exception {
        MvcResult result = preview(post("/sendproof/_preview/things/write"));
        var response = result.getResponse();
        assertThat(response.getStatus()).isEqualTo(HttpStatus.CONFLICT.value());
        assertThat(response.getHeader("Preference-Applied")).isNull();
        assertThat(response.getContentType()).startsWith("application/problem+json");
        assertThat(response.getHeader("Cache-Control")).contains("no-store");
        JsonNode problem = body(result);
        assertThat(problem.get("code").asText()).isEqualTo("preview_unavailable");
        assertThat(problem.get("store").asText()).isEqualTo("redis");
        assertThat(problem.get("operation").asText()).isEqualTo("INCR");
        assertThat(problem.get("detail").asText()).isEqualTo("Preview unavailable: this operation writes to Redis");
        assertThat(problem.get("rolledBack").asBoolean()).isFalse();
        assertThat(problem.has("body")).isFalse();
        assertThat(store.sent).as("No byte of the refused command reaches the store").isEmpty();
    }

    @Test
    void aBlockedPreviewAnswers409EvenWhenTheHandlerCaughtTheErrorAndReturned200() throws Exception {
        MvcResult result = preview(post("/sendproof/_preview/things/swallow"));
        assertThat(result.getResponse().getStatus()).isEqualTo(409);
        assertThat(body(result).get("operation").asText()).isEqualTo("GETDEL");
        assertThat(store.sent).isEmpty();
    }

    @Test
    void theGuardDoesNothingInSend() throws Exception {
        assertThat(mvc.perform(post("/things/write")).andReturn().getResponse().getStatus()).isEqualTo(200);
        assertThat(store.sent).containsExactly("INCR");
    }

    @Test
    void anUnavailableOperationNeverRunsItsHandlerInAPreviewButSendWorks() throws Exception {
        MvcResult result = preview(delete("/sendproof/_preview/things/clear"));
        assertThat(result.getResponse().getStatus()).isEqualTo(409);
        assertThat(result.getResponse().getHeader("Preference-Applied")).isNull();
        assertThat(store.sent).isEmpty();
        assertThat(mvc.perform(delete("/things/clear")).andReturn().getResponse().getStatus()).isEqualTo(200);
        assertThat(store.sent).containsExactly("DEL");
    }

    @Test
    void discoveryListsStoresUnavailableOperationsTheBindingAndNoSqlDatabase() throws Exception {
        JsonNode capabilities = JSON.readTree(mvc.perform(get("/sendproof/_api/capabilities")).andReturn().getResponse().getContentAsByteArray());
        JsonNode store = capabilities.get("dataStores").get(0);
        assertThat(store.get("system").asText()).isEqualTo("redis");
        assertThat(store.get("name").asText()).isEqualTo("cache");
        assertThat(store.get("mode").asText()).isEqualTo("guard");
        List<String> operations = new ArrayList<>();
        capabilities.get("previewOperations").forEach(op -> operations.add(op.get("method").asText() + " " + op.get("path").asText()));
        assertThat(operations).contains("GET /things/read", "POST /things/write").doesNotContain("DELETE /things/clear",
                "POST /things/announce");
        JsonNode clear = null;
        JsonNode announce = null;
        for (JsonNode entry : capabilities.get("previewUnavailable")) {
            if (entry.get("path").asText().equals("/things/clear")) {
                clear = entry;
            } else if (entry.get("path").asText().equals("/things/announce")) {
                announce = entry;
            }
        }
        assertThat(clear.get("reason").asText()).isEqualTo("Preview unavailable: this operation writes to Redis");
        assertThat(clear.get("stores").get(0).asText()).isEqualTo("redis");
        assertThat(announce.get("reason").asText()).isEqualTo("Sends a message that can't be recalled");
        assertThat(announce.has("stores")).isFalse();
        assertThat(capabilities.get("binding").get("language").asText()).isEqualTo("java");
        assertThat(capabilities.get("binding").get("framework").asText()).isEqualTo("Spring Boot");
        assertThat(capabilities.get("database").isNull()).isTrue();
    }
}
