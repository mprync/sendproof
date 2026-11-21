package io.github.mprync.sendproof.fixture;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * On the MySQL entry ({@code BENCH_DATABASE=mysql}), creates the procedure the shared mysql-escape rule calls, before the
 * server starts answering: {@code sendproof_commit_probe()}, which runs {@code COMMIT}. The fixture declares no
 * procedure as safe, so a Preview must refuse the {@code CALL}.
 */
@Component
public class MySqlProcedures {

    public MySqlProcedures(JdbcTemplate jdbc) {
        if ("mysql".equals(System.getenv("BENCH_DATABASE"))) {
            jdbc.execute("CREATE PROCEDURE IF NOT EXISTS sendproof_commit_probe() BEGIN COMMIT; END");
        }
    }
}
