package dev.testbench.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import dev.testbench.core.TestBenchCapture;
import dev.testbench.spring.testapp.RecordingProvider;
import dev.testbench.spring.testapp.TestApp;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

/** Test Bench is off by default and stays off in production unless explicitly allowed. */
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
        TestBenchCapture capture;

        @Test
        void nothingIsMountedAndEffectsAreNotSuppressed() throws Exception {
            assertThat(mvc.perform(get("/bench/_api/capabilities")).andReturn().getResponse().getStatus()).isEqualTo(404);
            assertThat(mvc.perform(get("/bench/")).andReturn().getResponse().getStatus()).isEqualTo(404);
            assertThat(mvc.perform(post("/bench/_preview/things").header("Prefer", "tx=rollback"))
                    .andReturn().getResponse().getStatus()).isEqualTo(404);
            assertThat(capture.tryRecordEffect("email", "x", null)).isFalse();
            assertThat(provider.begun).hasValue(0);
        }
    }

    @SpringBootTest(classes = TestApp.class, properties = {"testbench.enabled=true", "spring.profiles.active=prod"})
    @AutoConfigureMockMvc
    @Nested
    class UnderProduction {
        @Autowired
        MockMvc mvc;

        @Test
        void aProductionProfileKeepsItOffEvenWhenEnabled() throws Exception {
            assertThat(mvc.perform(get("/bench/_api/capabilities")).andReturn().getResponse().getStatus()).isEqualTo(404);
        }
    }

    @SpringBootTest(classes = TestApp.class, properties = {
            "testbench.enabled=true", "spring.profiles.active=prod", "testbench.allow-in-production=true"})
    @AutoConfigureMockMvc
    @Nested
    class ProductionOverride {
        @Autowired
        MockMvc mvc;

        @Test
        void theOverrideIsExplicit() throws Exception {
            assertThat(mvc.perform(get("/bench/_api/capabilities")).andReturn().getResponse().getStatus()).isEqualTo(200);
        }
    }
}
