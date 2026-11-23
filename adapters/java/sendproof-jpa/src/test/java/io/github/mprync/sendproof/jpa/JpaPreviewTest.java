package io.github.mprync.sendproof.jpa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.HeldPreview;
import io.github.mprync.sendproof.core.PreviewSessions;
import io.github.mprync.sendproof.core.RequestCapture;
import io.github.mprync.sendproof.jpa.testapp.WidgetService;
import javax.sql.DataSource;
import io.github.mprync.sendproof.jpa.testapp.JpaTestApp;
import java.security.Principal;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

@SpringBootTest(classes = JpaTestApp.class, properties = {
        "spring.datasource.url=jdbc:h2:mem:jpatest;DB_CLOSE_DELAY=-1",
        "spring.jpa.hibernate.ddl-auto=create-drop",
        "sendproof.enabled=true", "sendproof.environment=Development", "sendproof.sql.include-parameter-values=true"})
@AutoConfigureMockMvc
class JpaPreviewTest {
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
    JdbcTemplate jdbc;
    @Autowired
    JpaPreviewProvider provider;
    @Autowired
    WidgetService widgets;
    @Autowired
    DataSource dataSource;

    @BeforeEach
    void clean() {
        jdbc.update("delete from widgets");
    }

    private int count() {
        return jdbc.queryForObject("select count(*) from widgets", Integer.class);
    }

    @Test
    void theSpringRoutesKeepAndRewindJpaSteps() throws Exception {
        var user = new User("held-owner");
        String route = "/sendproof/_api/sessions";
        var opened = mvc.perform(post(route).principal(user)).andReturn();
        assertThat(opened.getResponse().getStatus()).isEqualTo(201);
        String id = json(opened).path("id").asText();
        String session = route + "/" + id;
        try {
            var create = mvc.perform(post("/sendproof/_preview/widgets/held-api?name=initial")
                    .principal(user).header("Prefer", "tx=rollback").header(PreviewSessions.HEADER, id)).andReturn();
            assertThat(create.getResponse().getStatus()).isEqualTo(200);
            assertThat(json(create).path("session").path("step").asInt()).isEqualTo(1);
            assertThat(count()).isZero();

            var rename = mvc.perform(patch("/sendproof/_preview/widgets/held-api?name=changed")
                    .principal(user).header("Prefer", "tx=rollback").header(PreviewSessions.HEADER, id)).andReturn();
            assertThat(rename.getResponse().getStatus()).isEqualTo(200);
            assertThat(json(rename).path("session").path("step").asInt()).isEqualTo(2);
            assertThat(mvc.perform(post(session + "/rewind").principal(user)
                    .contentType("application/json").content("{\"step\":2}")).andReturn()
                    .getResponse().getStatus()).isEqualTo(204);

            var retry = mvc.perform(patch("/sendproof/_preview/widgets/held-api?name=again")
                    .principal(user).header("Prefer", "tx=rollback").header(PreviewSessions.HEADER, id)).andReturn();
            assertThat(json(retry).path("session").path("step").asInt()).isEqualTo(2);
            assertThat(json(retry).path("changes").get(0).path("before").path("name").asText()).isEqualTo("initial");
        } finally {
            assertThat(mvc.perform(delete(session).principal(user)).andReturn().getResponse().getStatus()).isEqualTo(204);
        }
        assertThat(count()).isZero();
    }

    @Test
    @SuppressWarnings("try")
    void aHeldJpaStepKeepsWritesAndCaptureAcrossFreshTransactionsUntilRewind() throws Exception {
        assertThat(provider.supportsHeldPreview()).isTrue();
        RequestCapture capture = new RequestCapture();
        capture.begin(true, System.nanoTime());
        try (HeldPreview preview = provider.beginHeld()) {
            preview.checkpoint();
            try (var scope = CaptureContext.enter(capture); var step = preview.begin(capture)) {
                widgets.create("held", "first");
                step.finish();
                assertThat(step.changes()).hasSize(1);
            }
            assertThat(capture.finish().logs()).anyMatch(log -> log.sql() != null);
            assertThat(count()).isZero();

            var rename = preview.checkpoint();
            try (var step = preview.begin(new RequestCapture())) {
                widgets.rename("held", "second");
                step.finish();
                assertThat(step.changes()).hasSize(1);
                assertThat(jdbc.queryForObject("select name from widgets where id='held'", String.class))
                        .isEqualTo("second");
            }
            rename.rollback();
            rename.discard();
            preview.checkpoint();
            try (var step = preview.begin(new RequestCapture())) {
                assertThat(jdbc.queryForObject("select name from widgets where id='held'", String.class))
                        .isEqualTo("first");
                step.finish();
            }
        }
        assertThat(count()).isZero();
    }

    @Test
    @SuppressWarnings("try")
    void aRollbackOnlySpringJdbcStepRewindsItsOwnWrites() throws Exception {
        var manager = new DataSourceTransactionManager(dataSource);
        var jdbcProvider = new JpaPreviewProvider(manager, null, () -> "test");
        assertThat(jdbcProvider.supportsHeldPreview()).isTrue();
        try (var preview = jdbcProvider.beginHeld()) {
            preview.checkpoint();
            try (var step = preview.begin(new RequestCapture())) {
                jdbc.update("insert into widgets (id, name) values (?, ?)", "held", "kept");
                step.finish();
            }
            preview.checkpoint();
            try (var step = preview.begin(new RequestCapture())) {
                new TransactionTemplate(manager).executeWithoutResult(status -> {
                    jdbc.update("update widgets set name=? where id=?", "discarded", "held");
                    status.setRollbackOnly();
                });
                step.finish();
            }
            preview.checkpoint();
            try (var step = preview.begin(new RequestCapture())) {
                assertThat(jdbc.queryForObject("select name from widgets where id='held'", String.class))
                        .isEqualTo("kept");
                step.finish();
            }
        }
        assertThat(count()).isZero();
    }

    @Test
    @SuppressWarnings("try")
    void capturedH2SettingsAreRefusedDuringHeldPreview() throws Exception {
        try (var ordinary = provider.begin()) {
            jdbc.execute("SET SCHEMA PUBLIC");
            ordinary.rollback();
        }
        try (var held = provider.beginHeld()) {
            held.checkpoint();
            assertThatThrownBy(() -> {
                try (var step = held.begin(new RequestCapture())) {
                    widgets.create("held-setting", "before setting");
                    assertThatThrownBy(() -> jdbc.execute("SET SCHEMA PUBLIC"))
                            .hasStackTraceContaining("SQL statement SET");
                    assertThatThrownBy(step::finish).isInstanceOf(HeldPreview.UnsafeTransaction.class);
                }
            }).isInstanceOf(HeldPreview.UnsafeTransaction.class);
        }
        assertThat(count()).isZero();
    }

    @Test
    @SuppressWarnings("try")
    void aSwallowedConnectionCommitFailsTheHeldStep() throws Exception {
        try (var preview = provider.beginHeld()) {
            preview.checkpoint();
            var step = preview.begin(new RequestCapture());
            widgets.commitThroughTheConnection("held-commit");
            assertThatThrownBy(step::finish).isInstanceOf(HeldPreview.UnsafeTransaction.class);
            assertThatThrownBy(step::close).isInstanceOf(HeldPreview.UnsafeTransaction.class);
        }
        assertThat(count()).isZero();
    }

    private MvcResult preview(String method, String path) throws Exception {
        MockHttpServletRequestBuilder request = switch (method) {
            case "PATCH" -> patch("/sendproof/_preview" + path);
            case "DELETE" -> delete("/sendproof/_preview" + path);
            default -> post("/sendproof/_preview" + path);
        };
        return mvc.perform(request.header("Prefer", "tx=rollback")).andReturn();
    }

    private JsonNode json(MvcResult result) throws Exception {
        return JSON.readTree(result.getResponse().getContentAsByteArray());
    }

    @Test
    void aJpaInsertIsCapturedWithItsSqlAndRolledBack() throws Exception {
        MvcResult result = preview("POST", "/widgets/w1?name=Bolt");
        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        JsonNode envelope = json(result);
        assertThat(envelope.get("status").asInt()).isEqualTo(201);
        assertThat(envelope.get("rolledBack").asBoolean()).isTrue();

        JsonNode change = envelope.get("changes").get(0);
        assertThat(change.get("operation").asText()).isEqualTo("insert");
        assertThat(change.get("table").asText()).isEqualToIgnoringCase("widgets");
        assertThat(change.get("key").get("id").asText()).isEqualTo("w1");
        assertThat(change.get("before").isNull()).isTrue();
        assertThat(change.get("after").get("name").asText()).isEqualTo("Bolt");

        JsonNode sql = null;
        for (JsonNode log : envelope.get("logs")) {
            if (log.has("sql") && log.get("sql").get("text").asText().toLowerCase().startsWith("insert")) {
                sql = log.get("sql");
            }
        }
        assertThat(sql).as("insert statement logged").isNotNull();
        assertThat(sql.get("rowsAffected").asInt()).isEqualTo(1);
        var names = new ArrayList<String>();
        var values = new ArrayList<String>();
        sql.get("parameters").forEach(p -> {
            names.add(p.get("name").asText());
            values.add(p.get("value").asText());
        });
        assertThat(names).containsExactlyInAnyOrder("id", "name");
        assertThat(values).containsExactlyInAnyOrder("w1", "Bolt");
        assertThat(count()).isZero();
    }

    @Test
    void anOrdinarySendPersistsAndAnObservedSendTracesTheSameChange() throws Exception {
        MvcResult send = mvc.perform(post("/widgets/w2?name=Nut").header("Prefer", "trace").principal(new User("alice")))
                .andReturn();
        assertThat(send.getResponse().getStatus()).isEqualTo(201);
        assertThat(count()).isEqualTo(1);

        String id = send.getResponse().getHeader("X-Sendproof-Trace");
        JsonNode trace = json(mvc.perform(get("/sendproof/_api/traces/" + id).principal(new User("alice"))).andReturn());
        assertThat(trace.get("changes").get(0).get("key").get("id").asText()).isEqualTo("w2");
        assertThat(trace.get("timing").get("queryCount").asInt()).isPositive();
        assertThat(trace.get("logs").toString()).contains("insert");
    }

    @Test
    void updatesAndDeletesShowBeforeAndAfterValues() throws Exception {
        jdbc.update("insert into widgets (id, name) values ('w3', 'Old')");

        JsonNode update = json(preview("PATCH", "/widgets/w3?name=New"));
        JsonNode change = update.get("changes").get(0);
        assertThat(change.get("operation").asText()).isEqualTo("update");
        assertThat(change.get("before").get("name").asText()).isEqualTo("Old");
        assertThat(change.get("after").get("name").asText()).isEqualTo("New");

        JsonNode removal = json(preview("DELETE", "/widgets/w3"));
        JsonNode deleted = removal.get("changes").get(0);
        assertThat(deleted.get("operation").asText()).isEqualTo("delete");
        assertThat(deleted.get("before").get("name").asText()).isEqualTo("Old");
        assertThat(deleted.get("after").isNull()).isTrue();

        assertThat(jdbc.queryForObject("select name from widgets where id = 'w3'", String.class)).isEqualTo("Old");
    }

    @Test
    void aConstraintViolationSurfacesWhereARealCommitWouldRaiseIt() throws Exception {
        jdbc.update("insert into widgets (id, name) values ('dup', 'First')");
        JsonNode envelope = json(preview("POST", "/widgets/dup"));
        // The service's @Transactional boundary flushes on completion, so the host's handler sees (and maps) it.
        assertThat(envelope.get("status").asInt()).isEqualTo(409);
        assertThat(envelope.get("body").asText()).isEqualTo("duplicate");
        assertThat(count()).isEqualTo(1);
    }

    @Test
    void jdbcTemplateWritesAreRolledBackAndLoggedWithoutRowChanges() throws Exception {
        JsonNode envelope = json(preview("POST", "/jdbc/j1"));
        assertThat(envelope.get("status").asInt()).isEqualTo(200);
        assertThat(envelope.get("changes")).isEmpty();
        assertThat(envelope.get("logs").toString()).contains("insert into widgets");
        assertThat(count()).isZero();
    }

    @Test
    void aSecondTransactionIsRefusedBeforeItCanCommit() throws Exception {
        MvcResult result = preview("POST", "/escape/new-transaction/n1");
        assertThat(result.getResponse().getStatus()).isEqualTo(500);
        assertThat(result.getResponse().getHeader("Preference-Applied")).isNull();
        assertThat(count()).isZero();
    }

    @Test
    void aWriteOutsideAnyTransactionIsRefusedBeforeItPersists() throws Exception {
        MvcResult result = preview("POST", "/escape/autocommit/a1");
        assertThat(result.getResponse().getStatus()).isEqualTo(500);
        assertThat(result.getResponse().getHeader("Preference-Applied")).isNull();
        assertThat(count()).isZero();
    }

    @Test
    void aDirectConnectionCommitIsRefusedEvenWhenTheHandlerSwallowsIt() throws Exception {
        MvcResult result = preview("POST", "/escape/connection-commit/c1");
        assertThat(result.getResponse().getStatus()).isEqualTo(500);
        assertThat(result.getResponse().getHeader("Preference-Applied")).isNull();
        assertThat(count()).isZero();
    }

    @Test
    void aCommitStatementIsRefusedEvenWhenTheHandlerSwallowsIt() throws Exception {
        MvcResult result = preview("POST", "/escape/sql-commit/c2");
        assertThat(result.getResponse().getStatus()).isEqualTo(500);
        assertThat(result.getResponse().getHeader("Preference-Applied")).isNull();
        assertThat(count()).isZero();
    }

    @Test
    void secretColumnsAreHiddenInChangesAndSql() throws Exception {
        MvcResult result = preview("POST", "/logins/l1");
        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        JsonNode envelope = json(result);
        JsonNode after = envelope.get("changes").get(0).get("after");
        // Change records use the physical column names, as SQL rows do.
        assertThat(after.get("id").asText()).isEqualTo("l1");
        assertThat(after.get("password_hash").asText()).isEqualTo("[REDACTED]");
        assertThat(after.get("display_name").asText()).isEqualTo("Login l1");
        assertThat(after.has("passwordHash")).isFalse();
        // A secret property name hides its value even when the column name isn't secret.
        assertThat(after.get("recovery").asText()).isEqualTo("[REDACTED]");
        assertThat(envelope.toString()).doesNotContain("s3cret-hash");
        assertThat(jdbc.queryForObject("select count(*) from logins", Integer.class)).isZero();
    }

    @Test
    void changesAreCappedAndFlagged() throws Exception {
        JsonNode envelope = json(preview("POST", "/bulk/b"));
        assertThat(envelope.get("changes")).hasSize(200);
        assertThat(envelope.get("changesTruncated").asBoolean()).isTrue();
        assertThat(count()).isZero();
    }

    @Test
    void discoveryNamesTheDatabaseWithoutLeakingItsUrl() throws Exception {
        JsonNode capabilities = json(mvc.perform(get("/sendproof/_api/capabilities")).andReturn());
        assertThat(capabilities.get("database").get("name").asText()).isEqualTo("In-memory H2");
        assertThat(capabilities.get("database").get("system").asText()).isEqualTo("h2");
        assertThat(capabilities.get("binding").get("language").asText()).isEqualTo("java");
        assertThat(capabilities.toString()).doesNotContain("jdbc:").doesNotContain("jpatest");
        List<String> operations = new ArrayList<>();
        capabilities.get("previewOperations").forEach(o -> operations.add(o.get("method").asText() + " " + o.get("path").asText()));
        assertThat(operations).contains("POST /widgets/{id}", "PATCH /widgets/{id}", "DELETE /widgets/{id}");
    }

    @Autowired
    org.springframework.transaction.PlatformTransactionManager transactions;

    @Test
    void mysqlPreviewsOfOneProviderTakeTurnsAndOtherDatabasesDoNot() throws Exception {
        for (String system : new String[] {"mysql", "h2"}) {
            var provider = new JpaPreviewProvider(transactions, null, () -> "Test", () -> system);
            var open = new java.util.concurrent.atomic.AtomicInteger();
            var peak = new java.util.concurrent.atomic.AtomicInteger();
            var started = new java.util.concurrent.CountDownLatch(6);
            var finished = new java.util.concurrent.CountDownLatch(6);
            var failures = java.util.Collections.synchronizedList(new ArrayList<Throwable>());
            for (int i = 0; i < 6; i++) {
                new Thread(() -> {
                    try {
                        started.countDown();
                        started.await();
                        var session = provider.begin();
                        peak.accumulateAndGet(open.incrementAndGet(), Math::max);
                        Thread.sleep(60);
                        open.decrementAndGet();
                        session.rollback();
                        session.close();
                    } catch (Throwable failure) {
                        failures.add(failure);
                    } finally {
                        finished.countDown();
                    }
                }).start();
            }
            finished.await();
            assertThat(failures).isEmpty();
            if (system.equals("mysql")) {
                assertThat(peak).as("MySQL Previews take turns").hasValue(1);
            } else {
                assertThat(peak.get()).as("Other databases Preview concurrently").isGreaterThan(1);
            }
        }
    }
}
