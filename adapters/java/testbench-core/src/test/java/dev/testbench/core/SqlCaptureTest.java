package dev.testbench.core;

import static org.assertj.core.api.Assertions.assertThat;

import dev.testbench.core.SqlCapture.Binding;
import java.util.List;
import org.junit.jupiter.api.Test;

class SqlCaptureTest {

    @Test
    void namesComeFromColumnsAndAliases() {
        assertThat(SqlParameterNames.infer("insert into items (id, name) values (?, ?)")).containsExactly("id", "name");
        assertThat(SqlParameterNames.infer("update items set name = ? where id = ?")).containsExactly("name", "id");
        assertThat(SqlParameterNames.infer("select * from items i where i.name like ? and i.id in (?, ?)"))
                .containsExactly("name", "id", "id");
        assertThat(SqlParameterNames.infer("select cast(? as varchar) as fixture_secret"))
                .containsExactly("fixture_secret");
        assertThat(SqlParameterNames.infer("select ? as total")).containsExactly("total");
        assertThat(SqlParameterNames.infer("select * from t where created between ? and ?"))
                .containsExactly("created", "created");
        assertThat(SqlParameterNames.infer("select f(?, ?)")).containsExactly("p1", "p2");
    }

    @Test
    void literalsAndCommentsAreNotPlaceholders() {
        assertThat(SqlParameterNames.infer("select '?' /* ? */ -- ?\n from t where a = ?")).containsExactly("a");
    }

    @Test
    void secretsAreRedactedByNameOrByStatement() {
        var byName = SqlCapture.snapshot("update users set password_hash = ?, name = ? where id = ?",
                List.of(new Binding("h", "VARCHAR"), new Binding("n", "VARCHAR"), new Binding(7, "INTEGER")), 1, true);
        assertThat(byName.sql().parameters()).extracting("value").containsOnly(SqlRedaction.REDACTED);

        var plain = SqlCapture.snapshot("update items set name = ? where id = ?",
                List.of(new Binding("Bolt", "VARCHAR"), new Binding(12, "INTEGER")), 1, true);
        assertThat(plain.sql().parameters()).extracting("value").containsExactly("Bolt", "12");
        assertThat(plain.sql().rowsAffected()).isEqualTo(1);

        var hidden = SqlCapture.snapshot("select * from items where id = ?", List.of(new Binding(1, "INTEGER")), null, false);
        assertThat(hidden.sql().parameters()).extracting("value").containsExactly(SqlRedaction.REDACTED);
    }

    @Test
    void wholeWordMatchingKeepsOrdinaryNamesVisible() {
        assertThat(SqlRedaction.looksSecret("idempotency_key")).isFalse();
        assertThat(SqlRedaction.looksSecret("monkey")).isFalse();
        assertThat(SqlRedaction.looksSecret("primary key")).isFalse();
        assertThat(SqlRedaction.looksSecret("PasswordHash")).isTrue();
        assertThat(SqlRedaction.looksSecret("api_key")).isTrue();
        assertThat(SqlRedaction.looksSecret("refreshToken")).isTrue();
        assertThat(SqlRedaction.looksSecret("fixture_secret")).isTrue();
    }

    @Test
    void longTextAndBytesAreBounded() {
        var snapshot = SqlCapture.snapshot("insert into t (a, b) values (?, ?)",
                List.of(new Binding("x".repeat(10_000), "VARCHAR"), new Binding(new byte[10_000], "VARBINARY")), null, true);
        assertThat(snapshot.truncated()).isTrue();
        assertThat(snapshot.sql().parameters().get(0).value()).hasSize(CaptureLimits.TEXT);
        assertThat(snapshot.sql().parameters().get(1).value()).hasSize(CaptureLimits.TEXT);
    }
}
