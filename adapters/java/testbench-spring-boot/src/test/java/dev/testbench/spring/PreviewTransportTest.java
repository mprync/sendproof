package dev.testbench.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.head;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.testbench.spring.testapp.FilterEndpoint;
import dev.testbench.spring.testapp.RecordingProvider;
import dev.testbench.spring.testapp.TestApp;
import java.security.Principal;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

@SpringBootTest(classes = TestApp.class, properties = {
        "testbench.enabled=true", "testbench.environment=Development", "testbench.trace.retention=5s"})
@AutoConfigureMockMvc
class PreviewTransportTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    record User(String name) implements Principal {
        @Override
        public String getName() {
            return name;
        }
    }

    @Autowired
    MockMvc mvc;
    @Autowired
    RecordingProvider provider;

    @BeforeEach
    void reset() {
        provider.reset();
    }

    private static MockHttpServletRequestBuilder preview(String path) {
        return post("/tenant/bench/_preview" + path).contextPath("/tenant").header("Prefer", "tx=rollback");
    }

    private JsonNode body(MvcResult result) throws Exception {
        return JSON.readTree(result.getResponse().getContentAsByteArray());
    }

    @Test
    void aMarkedOperationIsConfirmedAfterRollback() throws Exception {
        MvcResult result = mvc.perform(preview("/things")).andReturn();
        var response = result.getResponse();
        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(response.getHeader("Preference-Applied")).isEqualTo("tx=rollback");
        assertThat(response.getHeader("Cache-Control")).contains("no-store");
        assertThat(response.getHeader("Server-Timing")).contains("handler;dur=");
        assertThat(response.getHeader("Set-Cookie")).isNull();
        assertThat(response.getContentType()).startsWith("application/json");

        JsonNode envelope = body(result);
        assertThat(envelope.get("rolledBack").asBoolean()).isTrue();
        assertThat(envelope.get("status").asInt()).isEqualTo(201);
        assertThat(envelope.get("body").get("suppressed").asText()).isEqualTo("true");
        assertThat(envelope.get("changes").get(0).get("operation").asText()).isEqualTo("insert");
        assertThat(envelope.get("effects").get(0).get("description").asText()).isEqualTo("Created thing");
        assertThat(envelope.get("effects").get(0).has("delivered")).isFalse();
        assertThat(envelope.get("logs").findValuesAsText("message")).contains("created thing");
        assertThat(provider.begun).hasValue(1);
        assertThat(provider.rolledBack).hasValue(1);
        assertThat(provider.closed).hasValue(1);
    }

    @Test
    void thePathBaseAndRegexVariablesWork() throws Exception {
        JsonNode envelope = body(mvc.perform(preview("/things/42").with(r -> {
            r.setMethod("PATCH");
            return r;
        })).andReturn());
        assertThat(envelope.get("status").asInt()).isEqualTo(200);
        assertThat(envelope.get("body").get("id").asText()).isEqualTo("42");
    }

    @Test
    void aHandledApplicationErrorIsStillConfirmed() throws Exception {
        JsonNode envelope = body(mvc.perform(preview("/things/conflict")).andReturn());
        assertThat(envelope.get("status").asInt()).isEqualTo(409);
        assertThat(envelope.get("rolledBack").asBoolean()).isTrue();
        assertThat(provider.rolledBack).hasValue(1);
    }

    @Test
    void anUnhandledExceptionRollsBackButIsNeverConfirmed() throws Exception {
        MvcResult result = mvc.perform(preview("/things/boom")).andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(500);
        assertThat(result.getResponse().getHeader("Preference-Applied")).isNull();
        assertThat(provider.rolledBack).hasValue(1);
        assertThat(provider.closed).hasValue(1);
    }

    @Test
    void aFailedRollbackIsNeverConfirmed() throws Exception {
        provider.failRollback = true;
        MvcResult result = mvc.perform(preview("/things")).andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(500);
        assertThat(result.getResponse().getHeader("Preference-Applied")).isNull();
        assertThat(provider.closed).hasValue(1);
    }

    @Test
    void aProviderThatCannotBeginDoesNotRunTheHandlerToConfirmation() throws Exception {
        provider.failBegin = true;
        MvcResult result = mvc.perform(preview("/things")).andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(500);
        assertThat(result.getResponse().getHeader("Preference-Applied")).isNull();
        assertThat(provider.begun).hasValue(0);
    }

    @Test
    void anOversizedResponseIsRejected() throws Exception {
        MvcResult result = mvc.perform(preview("/things/large")).andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(413);
        assertThat(provider.rolledBack).hasValue(1);
    }

    @Test
    void redirectsAreReportedNotFollowedAndNeverLeakTheirHeaders() throws Exception {
        MvcResult result = mvc.perform(preview("/things/redirect")).andReturn();
        JsonNode envelope = body(result);
        assertThat(envelope.get("status").asInt()).isEqualTo(302);
        assertThat(envelope.get("headers").has("location")).isFalse();
        assertThat(envelope.get("headers").has("set-cookie")).isFalse();
        assertThat(result.getResponse().getHeader("Set-Cookie")).isNull();
        assertThat(result.getResponse().getHeader("Location")).isNull();
    }

    @Test
    void invalidTransportNeverExecutesTheHandler() throws Exception {
        assertThat(status(post("/tenant/bench/_preview/things").contextPath("/tenant"))).isEqualTo(400);
        assertThat(status(post("/tenant/bench/_preview/things").contextPath("/tenant")
                .header("Prefer", "tx=\"rollback\""))).isEqualTo(400);
        assertThat(status(post("/tenant/bench/_preview/things").contextPath("/tenant")
                .header("Prefer", "trace, tx=rollback"))).isEqualTo(400);
        assertThat(status(post("/tenant/things").contextPath("/tenant").header("Prefer", "tx=rollback"))).isEqualTo(400);
        assertThat(status(head("/tenant/bench/_preview/things").contextPath("/tenant")
                .header("Prefer", "tx=rollback"))).isEqualTo(405);
        assertThat(status(post(java.net.URI.create("/tenant/bench/_preview//things")).contextPath("/tenant")
                .header("Prefer", "tx=rollback"))).isEqualTo(400);
        assertThat(status(preview("/bench/_api/capabilities"))).isEqualTo(400);
        assertThat(status(preview("/a/../things"))).isEqualTo(400);
        assertThat(status(preview("/things").header("Origin", "https://elsewhere.example.test"))).isEqualTo(403);
        assertThat(status(preview("/things").header("Sec-Fetch-Site", "cross-site"))).isEqualTo(403);
        assertThat(provider.begun).hasValue(0);
    }

    @Test
    void unmarkedAndUnknownTargetsAreRefused() throws Exception {
        assertThat(status(preview("/things/unmarked"))).isEqualTo(409);
        assertThat(status(preview("/missing"))).isEqualTo(404);
        assertThat(provider.begun).hasValue(0);
    }

    @Test
    void aFilterLevelEndpointNeverRunsForAPreview() throws Exception {
        FilterEndpoint.HITS.set(0);
        assertThat(status(post("/tenant/filter-endpoint").contextPath("/tenant"))).isEqualTo(204);
        assertThat(FilterEndpoint.HITS).hasValue(1);
        // The target is resolved before the filter chain runs: no controller is marked, so nothing executes.
        assertThat(status(preview("/filter-endpoint"))).isEqualTo(404);
        assertThat(status(preview("/filter-endpoint").header("Origin", "https://elsewhere.example.test")))
                .isEqualTo(403);
        assertThat(FilterEndpoint.HITS).hasValue(1);
        assertThat(provider.begun).hasValue(0);
    }

    @Test
    void theMethodIsCheckedAgainstTheRealMapping() throws Exception {
        assertThat(status(post("/tenant/bench/_preview/things/12").contextPath("/tenant")
                .header("Prefer", "tx=rollback"))).isEqualTo(405);
        assertThat(provider.begun).hasValue(0);
    }

    @Test
    void aPreviewSegmentDeeperInThePathIsAnOrdinaryUrl() throws Exception {
        // Only <mount>/bench/_preview is reserved; deeper, the rollback preference is refused like on any other URL.
        MvcResult result = mvc.perform(post("/tenant/bench/bench/_preview/_api/capabilities").contextPath("/tenant")
                .header("Prefer", "tx=rollback")).andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(400);
        assertThat(body(result).get("title").asText()).contains("Use the Test Bench preview URL");
        assertThat(status(post("/tenant/x/bench/_preview/things").contextPath("/tenant")
                .header("Prefer", "tx=rollback"))).isEqualTo(400);
        assertThat(provider.begun).hasValue(0);
    }

    @Test
    void anObservedSendKeepsItsResponseAndPublishesAnOwnerOnlyTrace() throws Exception {
        MvcResult send = mvc.perform(post("/tenant/things").contextPath("/tenant").header("Prefer", "trace")
                .principal(new User("alice"))).andReturn();
        assertThat(send.getResponse().getStatus()).isEqualTo(201);
        String traceId = send.getResponse().getHeader("X-TestBench-Trace");
        assertThat(traceId).matches("[0-9a-f]{32}");
        assertThat(send.getResponse().getHeader("Cache-Control")).contains("no-store");

        MvcResult owned = mvc.perform(get("/tenant/bench/_api/traces/" + traceId).contextPath("/tenant")
                .principal(new User("alice"))).andReturn();
        assertThat(owned.getResponse().getStatus()).isEqualTo(200);
        JsonNode trace = body(owned);
        assertThat(trace.get("effects").get(0).get("delivered").asBoolean()).isTrue();
        assertThat(trace.get("changes").get(0).get("operation").asText()).isEqualTo("update");
        assertThat(trace.get("timing").has("queryCount")).isTrue();

        assertThat(status(get("/tenant/bench/_api/traces/" + traceId).contextPath("/tenant")
                .principal(new User("bob")))).isEqualTo(404);
        assertThat(status(get("/tenant/bench/_api/traces/" + traceId).contextPath("/tenant"))).isEqualTo(404);
        assertThat(status(get("/tenant/bench/_api/traces/not-a-trace").contextPath("/tenant")
                .principal(new User("alice")))).isEqualTo(404);
        assertThat(provider.begun).hasValue(0);
    }

    @Test
    void anAnonymousOrUnmarkedOrCrossOriginSendIsNotTraced() throws Exception {
        assertThat(mvc.perform(post("/tenant/things").contextPath("/tenant").header("Prefer", "trace"))
                .andReturn().getResponse().getHeader("X-TestBench-Trace")).isNull();
        assertThat(mvc.perform(post("/tenant/things/unmarked").contextPath("/tenant").header("Prefer", "trace")
                .principal(new User("alice"))).andReturn().getResponse().getHeader("X-TestBench-Trace")).isNull();
        assertThat(mvc.perform(post("/tenant/things").contextPath("/tenant").header("Prefer", "trace")
                .header("Origin", "https://elsewhere.example.test").principal(new User("alice")))
                .andReturn().getResponse().getHeader("X-TestBench-Trace")).isNull();
    }

    @Test
    void anOrdinarySendWithoutTheHeaderIsUntouched() throws Exception {
        MvcResult send = mvc.perform(patch("/tenant/things/7").contextPath("/tenant").principal(new User("alice")))
                .andReturn();
        assertThat(send.getResponse().getStatus()).isEqualTo(200);
        assertThat(send.getResponse().getHeader("X-TestBench-Trace")).isNull();
        assertThat(send.getResponse().getHeader("Server-Timing")).isNull();
    }

    private int status(MockHttpServletRequestBuilder request) throws Exception {
        return mvc.perform(request).andReturn().getResponse().getStatus();
    }
}
