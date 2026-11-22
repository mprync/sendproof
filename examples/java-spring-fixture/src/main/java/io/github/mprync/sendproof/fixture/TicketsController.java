package io.github.mprync.sendproof.fixture;

import com.datastax.oss.driver.api.core.CqlSession;
import com.datastax.oss.driver.api.core.cql.BatchStatement;
import com.datastax.oss.driver.api.core.cql.BatchType;
import com.datastax.oss.driver.api.core.cql.PreparedStatement;
import com.datastax.oss.driver.api.core.cql.Row;
import com.datastax.oss.driver.api.core.cql.SimpleStatement;
import io.github.mprync.sendproof.spring.SendproofPreview;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** The Cassandra routes of the fixture contract, through the (guarded) {@code CqlSession} bean. */
@RestController
@RequestMapping("/tickets")
@ConditionalOnProperty("bench.cassandra.contact-point")
public class TicketsController {
    private final CqlSession session;
    private volatile PreparedStatement select;

    public TicketsController(CqlSession session) {
        this.session = session;
    }

    /** The prepared SELECT, prepared once: executions are classified by the text it was prepared from. */
    private PreparedStatement select() {
        if (select == null) {
            select = session.prepare("SELECT id, status, hits FROM tickets WHERE id = ?");
        }
        return select;
    }

    @SendproofPreview
    @GetMapping("/{id}")
    public ResponseEntity<Map<String, Object>> get(@PathVariable String id) {
        Row row = session.execute(select().bind(id)).one();
        if (row == null) {
            return ResponseEntity.notFound().build();
        }
        var view = new LinkedHashMap<String, Object>();
        view.put("id", row.getString("id"));
        view.put("status", row.getString("status"));
        view.put("hits", row.getInt("hits"));
        return ResponseEntity.ok(view);
    }

    @SendproofPreview
    @PostMapping("/{id}/touch")
    public Map<String, Object> touch(@PathVariable String id) {
        touchTicket(id);
        var view = new LinkedHashMap<String, Object>();
        view.put("id", id);
        view.put("status", "new");
        view.put("hits", 1);
        return view;
    }

    /** Shared with the mixed SQL and store route. */
    void touchTicket(String id) {
        session.execute(SimpleStatement.newInstance("INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)", id));
    }

    /** A logged batch holding a lightweight transaction: a write even though its condition could fail. */
    @SendproofPreview
    @PostMapping("/{id}/close")
    public Map<String, Object> close(@PathVariable String id) {
        session.execute(BatchStatement.newInstance(BatchType.LOGGED,
                SimpleStatement.newInstance("UPDATE tickets SET status = 'closed' WHERE id = ? IF EXISTS", id)));
        return Map.of("id", id, "status", "closed");
    }

    @SendproofPreview(enabled = false, stores = "cassandra")
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        session.execute(SimpleStatement.newInstance("DELETE FROM tickets WHERE id = ?", id));
        return ResponseEntity.noContent().build();
    }
}
