package dev.testbench.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.testbench.spring.testapp.TestApp;
import org.junit.jupiter.api.Test;
import org.springdoc.core.models.GroupedOpenApi;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(classes = TestApp.class, properties = {
        "testbench.enabled=true", "testbench.environment=Development", "spring.application.name=Things API",
        "springdoc.api-docs.path=/docs", "testbench.auth-providers[0].label=Staff SSO",
        "testbench.auth-providers[0].kind=oidc", "testbench.auth-providers[0].url=/account/sign-in",
        "testbench.field-modules[0]=/assets/fields.js"})
@AutoConfigureMockMvc
@Import(DiscoveryTest.Groups.class)
class DiscoveryTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @TestConfiguration
    static class Groups {
        @Bean
        GroupedOpenApi publicApi() {
            return GroupedOpenApi.builder().group("public").pathsToMatch("/things/**").build();
        }
    }

    @Autowired
    MockMvc mvc;

    private JsonNode capabilities(String mount) throws Exception {
        var response = mvc.perform(get(mount + "/bench/_api/capabilities").contextPath(mount)).andReturn().getResponse();
        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(response.getHeader("Cache-Control")).contains("no-store");
        assertThat(response.getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
        return JSON.readTree(response.getContentAsByteArray());
    }

    @Test
    void capabilitiesAdvertiseSpringdocGroupsPreviewOperationsAndSignIn() throws Exception {
        JsonNode capabilities = capabilities("/tenant");
        assertThat(capabilities.get("protocolVersion").asInt()).isEqualTo(1);
        assertThat(capabilities.get("apiName").asText()).isEqualTo("Things API");
        assertThat(capabilities.get("environment").asText()).isEqualTo("Development");
        assertThat(capabilities.get("database").asText()).isEqualTo("Fake DB");
        assertThat(capabilities.get("identity").isNull()).isTrue();
        assertThat(capabilities.get("openApiUrl").asText()).isEqualTo("/tenant/docs/public");
        assertThat(capabilities.get("documents").get(0).get("name").asText()).isEqualTo("public");
        assertThat(capabilities.get("documents").get(0).get("url").asText()).isEqualTo("/tenant/docs/public");
        assertThat(capabilities.get("fieldModules").get(0).asText()).isEqualTo("/tenant/assets/fields.js");
        assertThat(capabilities.get("authProviders").get(0).get("url").asText()).isEqualTo("/tenant/account/sign-in");
        assertThat(capabilities.get("authProviders").get(0).get("kind").asText()).isEqualTo("oidc");
        assertThat(capabilities.get("observedSend").asBoolean()).isTrue();

        var operations = capabilities.get("previewOperations");
        var rendered = new java.util.ArrayList<String>();
        operations.forEach(operation -> rendered.add(operation.get("method").asText() + " " + operation.get("path").asText()));
        assertThat(rendered).contains("POST /things", "PATCH /things/{id}", "POST /things/conflict", "POST /things/large")
                .doesNotContain("POST /things/unmarked", "GET /things/{id}");
    }

    @Test
    void theWorkbenchIsHiddenFromTheOpenApiDocument() throws Exception {
        var response = mvc.perform(get("/docs/public")).andReturn().getResponse();
        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(response.getContentAsString()).contains("/things").doesNotContain("/bench");
    }

    @Test
    void theEmbeddedUiIsServedUnderTheMountWithSafeHeaders() throws Exception {
        var redirect = mvc.perform(get("/tenant/bench").queryParam("from", "x").contextPath("/tenant")).andReturn().getResponse();
        assertThat(redirect.getStatus()).isEqualTo(302);
        assertThat(redirect.getHeader("Location")).isEqualTo("/tenant/bench/?from=x");

        var index = mvc.perform(get("/tenant/bench/").contextPath("/tenant")).andReturn().getResponse();
        assertThat(index.getStatus()).isEqualTo(200);
        assertThat(index.getContentType()).startsWith("text/html");
        assertThat(index.getHeader("Cache-Control")).contains("no-cache");
        assertThat(index.getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
        assertThat(index.getContentAsString()).contains("Test Bench");

        String etag = index.getHeader("ETag");
        assertThat(etag).isNotBlank();
        assertThat(mvc.perform(get("/tenant/bench/").contextPath("/tenant").header("If-None-Match", etag))
                .andReturn().getResponse().getStatus()).isEqualTo(304);
        assertThat(mvc.perform(get("/tenant/bench/does-not-exist.js").contextPath("/tenant"))
                .andReturn().getResponse().getStatus()).isEqualTo(404);
        assertThat(mvc.perform(get("/tenant/bench/../secret").contextPath("/tenant"))
                .andReturn().getResponse().getStatus()).isIn(400, 404);
    }
}
