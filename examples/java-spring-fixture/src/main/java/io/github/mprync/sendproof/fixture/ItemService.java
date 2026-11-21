package io.github.mprync.sendproof.fixture;

import io.github.mprync.sendproof.core.SendproofCapture;
import jakarta.persistence.EntityManager;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/** Data access for items. Each public method is one ordinary {@code @Transactional} unit of work. */
@Service
public class ItemService {
    private static final Logger LOG = LoggerFactory.getLogger(ItemService.class);

    private final EntityManager entities;
    private final SendproofCapture capture;
    private final Outbox outbox;

    public ItemService(EntityManager entities, SendproofCapture capture, Outbox outbox) {
        this.entities = entities;
        this.capture = capture;
        this.outbox = outbox;
    }

    @Transactional(readOnly = true)
    public Item find(String id) {
        return entities.find(Item.class, id);
    }

    /** Inserts an item, reports the "Created item" email effect and runs a statement with a secret-named binding. */
    @Transactional
    public Item create(String id, String name) {
        Item item = new Item(id, name);
        entities.persist(item);
        LOG.info("created:{}", id);
        // A bound parameter whose name marks it secret; adapters must never show its value.
        entities.createNativeQuery("select cast(:fixture_secret as char(100)) as fixture_secret")
                .setParameter("fixture_secret", "fixture-secret-value").getSingleResult();
        if (!capture.tryRecordEmail("Created item", "fixture@example.test", List.of("ops@example.test"), List.of(),
                "Item created", "Item " + id + " was created.", null)) {
            outbox.deliver("Item created: " + id);
        }
        return item;
    }

    @Transactional
    public Item rename(String id, String name) {
        Item item = entities.find(Item.class, id);
        if (item == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
        item.setName(name);
        return item;
    }

    @Transactional
    public void delete(String id) {
        Item item = entities.find(Item.class, id);
        if (item != null) {
            entities.remove(item);
        }
    }

    /** Inserts the item and then fails with a handled application error; nothing persists in either mode. */
    @Transactional
    public void insertThenFail(String id) {
        entities.persist(new Item(id, "failing"));
        throw new ResponseStatusException(HttpStatus.CONFLICT, "Handled application failure.");
    }

    /** Inserts an item with no effects, for the operation that is not marked for preview. */
    @Transactional
    public Item insert(String id, String name) {
        Item item = new Item(id, name);
        entities.persist(item);
        return item;
    }

    /** Inserts the item, then ends the transaction by hand with a raw COMMIT, which a Preview must refuse. */
    @Transactional
    public Item insertThenCommit(String id, String name) {
        Item item = new Item(id, name);
        entities.persist(item);
        entities.flush();
        entities.createNativeQuery("COMMIT").executeUpdate();
        return item;
    }

    /**
     * Inserts the item, then on the same connection runs, by {@code via}: {@code ddl}, a {@code CREATE TABLE} that MySQL
     * commits implicitly; {@code call}, {@code CALL sendproof_commit_probe()}, a procedure that commits (see
     * {@link MySqlProcedures}). A Preview must refuse either before it is sent.
     */
    @Transactional
    public Item insertThenEscape(String id, String name, String via) {
        if (!id.matches("[A-Za-z0-9_]{1,40}")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "The id must be letters, digits or underscores.");
        }
        String statement = switch (via) {
            case "ddl" -> "CREATE TABLE sendproof_escape_" + id + " (n INT)";
            case "call" -> "CALL sendproof_commit_probe()";
            default -> throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "via must be ddl or call.");
        };
        Item item = new Item(id, name);
        entities.persist(item);
        entities.flush();
        entities.createNativeQuery(statement).executeUpdate();
        return item;
    }

    /** Exceeds the default caps: 205 changes, 105 effects and 505 log lines in one request. */
    @Transactional
    public int capture(String prefix) {
        for (int i = 0; i < 205; i++) {
            entities.persist(new Item(prefix + "-" + i, "Bulk " + i));
        }
        for (int i = 0; i < 105; i++) {
            if (!capture.tryRecordEffect("message", "Bulk effect " + i, Map.of("topic", "bulk", "n", i))) {
                outbox.deliver("bulk " + i);
            }
        }
        for (int i = 0; i < 505; i++) {
            LOG.info("capture-line:{}", i);
        }
        return 205;
    }
}
