package io.github.mprync.sendproof.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import io.github.mprync.sendproof.core.SendproofCapture;
import io.github.mprync.sendproof.spring.testapp.RecordingProvider;
import io.github.mprync.sendproof.spring.testapp.TestApp;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

/** Sendproof is off by default and stays off in production unless explicitly allowed. */
class OptInTest {

    @SpringBootTest(classes = TestApp.class)
    @AutoConfigureMockMvc
    @Nested
    class ByDefault {
        @Autowired
        MockMvc mvc;
        @Autowired
        RecordingProvider provider;
        @Autowired
        SendproofCapture capture;

        @Test
        void nothingIsMountedAndEffectsAreNotSuppressed() throws Exception {
            assertThat(mvc.perform(get("/sendproof/_api/capabilities")).andReturn().getResponse().getStatus()).isEqualTo(404);
            assertThat(mvc.perform(get("/sendproof/")).andReturn().getResponse().getStatus()).isEqualTo(404);
            assertThat(mvc.perform(post("/sendproof/_preview/things").header("Prefer", "tx=rollback"))
                    .andReturn().getResponse().getStatus()).isEqualTo(404);
            assertThat(capture.tryRecordEffect("email", "x", null)).isFalse();
            assertThat(provider.begun).hasValue(0);
        }
    }

    @SpringBootTest(classes = TestApp.class, properties = {"sendproof.enabled=true", "spring.profiles.active=prod"})
    @AutoConfigureMockMvc
    @Nested
    class UnderProduction {
        @Autowired
        MockMvc mvc;

        @Test
        void aProductionProfileKeepsItOffEvenWhenEnabled() throws Exception {
            assertThat(mvc.perform(get("/sendproof/_api/capabilities")).andReturn().getResponse().getStatus()).isEqualTo(404);
        }
    }

    @SpringBootTest(classes = TestApp.class, properties = {
            "sendproof.enabled=true", "spring.profiles.active=prod", "sendproof.allow-in-production=true"})
    @AutoConfigureMockMvc
    @Nested
    class ProductionOverride {
        @Autowired
        MockMvc mvc;

        @Test
        void theOverrideIsExplicit() throws Exception {
            assertThat(mvc.perform(get("/sendproof/_api/capabilities")).andReturn().getResponse().getStatus()).isEqualTo(200);
        }
    }
}
