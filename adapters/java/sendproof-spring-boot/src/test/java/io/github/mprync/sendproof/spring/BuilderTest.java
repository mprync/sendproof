package io.github.mprync.sendproof.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.mprync.sendproof.core.Capabilities.Identity;
import io.github.mprync.sendproof.spring.testapp.TestApp;
import java.time.Duration;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.test.web.servlet.MockMvc;

/** The {@link Sendproof} builder: precedence over properties, explicit beans, and unchanged environment gating. */
class BuilderTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @TestConfiguration
    static class Configured {
        @Bean
        Sendproof sendproof() {
            return Sendproof.builder()
                    .apiName("Builder API")
                    .environment("Staging")
                    .openApiDocument("Previous", "/docs/v0")
                    .authProvider("Staff SSO", "oidc", "/account/sign-in")
                    .fieldModule("/assets/builder-fields.js")
                    .traceRetention(Duration.ofSeconds(30))
                    .identityResolver(request -> new Identity("Builder User", "dev"))
                    .build();
        }
    }

    private static JsonNode capabilities(MockMvc mvc) throws Exception {
        var response = mvc.perform(get("/sendproof/_api/capabilities")).andReturn().getResponse();
        assertThat(response.getStatus()).isEqualTo(200);
        return JSON.readTree(response.getContentAsByteArray());
    }

    @Nested
    @SpringBootTest(classes = TestApp.class, properties = {
            "sendproof.enabled=true", "sendproof.api-name=Property API", "sendproof.environment=FromProperty",
            "sendproof.field-modules[0]=/assets/property-fields.js",
            "sendproof.auth-providers[0].label=Property login", "sendproof.auth-providers[0].kind=cookie",
            "sendproof.auth-providers[0].url=/auth/sign-in"})
    @AutoConfigureMockMvc
    @Import(Configured.class)
    class BuilderOverProperties {
        @Autowired
        MockMvc mvc;
        @Autowired
        SendproofSettings settings;

        @Test
        void builderValuesWinAndListsAreReplaced() throws Exception {
            JsonNode capabilities = capabilities(mvc);
            assertThat(capabilities.get("apiName").asText()).isEqualTo("Builder API");
            assertThat(capabilities.get("environment").asText()).isEqualTo("Staging");
            assertThat(capabilities.get("fieldModules")).hasSize(1);
            assertThat(capabilities.get("fieldModules").get(0).asText()).isEqualTo("/assets/builder-fields.js");
            assertThat(capabilities.get("authProviders")).hasSize(1);
            assertThat(capabilities.get("authProviders").get(0).get("label").asText()).isEqualTo("Staff SSO");
            assertThat(capabilities.get("documents").toString()).contains("/docs/v0");
            assertThat(settings.traceRetention()).isEqualTo(Duration.ofSeconds(30));
        }

        @Test
        void aBuilderResolverReplacesTheDefault() throws Exception {
            JsonNode identity = capabilities(mvc).get("identity");
            assertThat(identity.get("name").asText()).isEqualTo("Builder User");
            assertThat(identity.get("role").asText()).isEqualTo("dev");
        }
    }

    @Nested
    @SpringBootTest(classes = TestApp.class, properties = {
            "sendproof.enabled=true", "sendproof.api-name=Property API", "sendproof.environment=FromProperty",
            "sendproof.trace.retention=45s", "sendproof.field-modules[0]=/assets/property-fields.js"})
    @AutoConfigureMockMvc
    class PropertiesOnly {
        @Autowired
        MockMvc mvc;
        @Autowired
        SendproofSettings settings;

        @Test
        void propertiesApplyWhenThereIsNoBuilder() throws Exception {
            JsonNode capabilities = capabilities(mvc);
            assertThat(capabilities.get("apiName").asText()).isEqualTo("Property API");
            assertThat(capabilities.get("environment").asText()).isEqualTo("FromProperty");
            assertThat(capabilities.get("fieldModules").get(0).asText()).isEqualTo("/assets/property-fields.js");
            assertThat(settings.traceRetention()).isEqualTo(Duration.ofSeconds(45));
        }
    }

    @TestConfiguration
    static class ConfiguredWithPermissiveAccess {
        @Bean
        Sendproof sendproof() {
            return Sendproof.builder().identityResolver(request -> new Identity("Builder User", null))
                    .workbenchAccess(request -> true).build();
        }
    }

    @TestConfiguration
    static class ExplicitIdentity {
        @Bean
        WorkbenchIdentityResolver explicitIdentity() {
            return request -> new Identity("Explicit User", null);
        }
    }

    @TestConfiguration
    static class ExplicitDenyingAccess {
        @Bean
        WorkbenchAccess explicitAccess() {
            return request -> false;
        }
    }

    @Nested
    @SpringBootTest(classes = TestApp.class, properties = "sendproof.enabled=true")
    @AutoConfigureMockMvc
    @Import({ConfiguredWithPermissiveAccess.class, ExplicitIdentity.class})
    class ExplicitIdentityBeatsBuilder {
        @Autowired
        MockMvc mvc;

        @Test
        void anExplicitBeanBeatsTheBuilder() throws Exception {
            assertThat(capabilities(mvc).get("identity").get("name").asText()).isEqualTo("Explicit User");
        }
    }

    @Nested
    @SpringBootTest(classes = TestApp.class, properties = "sendproof.enabled=true")
    @AutoConfigureMockMvc
    @Import({ConfiguredWithPermissiveAccess.class, ExplicitDenyingAccess.class})
    class ExplicitAccessBeatsBuilder {
        @Autowired
        MockMvc mvc;

        @Test
        void anExplicitAccessPolicyDeniesDespiteAPermissiveBuilder() throws Exception {
            assertThat(mvc.perform(get("/sendproof/_api/capabilities")).andReturn().getResponse().getStatus()).isEqualTo(403);
        }
    }

    @Nested
    @SpringBootTest(classes = TestApp.class)
    @AutoConfigureMockMvc
    @Import(Configured.class)
    class DeclaringABuilderDoesNotEnable {
        @Autowired
        MockMvc mvc;

        @Test
        void gatingStaysPropertyOnly() throws Exception {
            assertThat(mvc.perform(get("/sendproof/_api/capabilities")).andReturn().getResponse().getStatus()).isEqualTo(404);
        }
    }

    @Nested
    @SpringBootTest(classes = TestApp.class, properties = {"sendproof.enabled=true", "spring.profiles.active=prod"})
    @AutoConfigureMockMvc
    @Import(Configured.class)
    class BuilderCannotBypassProductionGate {
        @Autowired
        MockMvc mvc;

        @Test
        void aBlockedProfileStaysOff() throws Exception {
            assertThat(mvc.perform(get("/sendproof/_api/capabilities")).andReturn().getResponse().getStatus()).isEqualTo(404);
        }
    }

    @Test
    void invalidInputFailsFast() {
        assertThatThrownBy(() -> Sendproof.builder().openApiUrl("https://elsewhere.example.test/spec"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Sendproof.builder().fieldModule("//evil.example.test/x.js"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Sendproof.builder().apiName(" ")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Sendproof.builder().traceRetention(Duration.ZERO))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(Sendproof.builder().build()).isNotNull();
    }
}
