package dev.testbench.jpa.testapp;

import jakarta.persistence.EntityManager;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class WidgetService {
    private final EntityManager entities;
    private final JdbcTemplate jdbc;

    public WidgetService(EntityManager entities, JdbcTemplate jdbc) {
        this.entities = entities;
        this.jdbc = jdbc;
    }

    @Transactional
    public void create(String id, String name) {
        entities.persist(new Widget(id, name));
    }

    @Transactional
    public void rename(String id, String name) {
        entities.find(Widget.class, id).setName(name);
    }

    @Transactional
    public void delete(String id) {
        entities.remove(entities.find(Widget.class, id));
    }

    @Transactional
    public void createMany(String prefix, int count) {
        for (int i = 0; i < count; i++) {
            entities.persist(new Widget(prefix + i, "n" + i));
        }
    }

    @Transactional
    public void jdbcInsert(String id) {
        jdbc.update("insert into widgets (id, name) values (?, ?)", id, "via jdbc");
    }

    /** Escapes the preview: a second transaction that would commit independently. */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void createInNewTransaction(String id) {
        entities.persist(new Widget(id, "new tx"));
    }

    /** Escapes the preview: runs without a transaction, so the JDBC write would autocommit. */
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public void jdbcInsertOutsideTransaction(String id) {
        jdbc.update("insert into widgets (id, name) values (?, ?)", id, "autocommit");
    }
}
