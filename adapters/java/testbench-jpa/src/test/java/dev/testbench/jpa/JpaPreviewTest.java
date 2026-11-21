package dev.testbench.jpa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.testbench.jpa.testapp.JpaTestApp;
import java.security.Principal;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

@SpringBootTest(classes = JpaTestApp.class, properties = {
        "spring.datasource.url=jdbc:h2:mem:jpatest;DB_CLOSE_DELAY=-1",
        "spring.jpa.hibernate.ddl-auto=create-drop",
        "testbench.enabled=true", "testbench.environment=Development", "testbench.sql.include-parameter-values=true"})
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

    @BeforeEach
    void clean() {
        jdbc.update("delete from widgets");
    }

    private int count() {
        return jdbc.queryForObject("select count(*) from widgets", Integer.class);
    }

    private MvcResult preview(String method, String path) throws Exception {
        MockHttpServletRequestBuilder request = switch (method) {
            case "PATCH" -> patch("/bench/_preview" + path);
            case "DELETE" -> delete("/bench/_preview" + path);
            default -> post("/bench/_preview" + path);
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

        String id = send.getResponse().getHeader("X-TestBench-Trace");
        JsonNode trace = json(mvc.perform(get("/bench/_api/traces/" + id).principal(new User("alice"))).andReturn());
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
        assertThat(after.get("id").asText()).isEqualTo("l1");
        assertThat(after.get("passwordHash").asText()).isEqualTo("[REDACTED]");
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
        JsonNode capabilities = json(mvc.perform(get("/bench/_api/capabilities")).andReturn());
        assertThat(capabilities.get("database").asText()).isEqualTo("In-memory H2");
        assertThat(capabilities.toString()).doesNotContain("jdbc:").doesNotContain("jpatest");
        List<String> operations = new ArrayList<>();
        capabilities.get("previewOperations").forEach(o -> operations.add(o.get("method").asText() + " " + o.get("path").asText()));
        assertThat(operations).contains("POST /widgets/{id}", "PATCH /widgets/{id}", "DELETE /widgets/{id}");
    }
}
