package io.github.mprync.sendproof.fixture;

import io.github.mprync.sendproof.spring.SendproofPreview;
import jakarta.persistence.EntityManager;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The shared secret-column rule: accounts are stored with {@code password_hash} as the literal {@code hashed:<password>},
 * which no capture may ever show.
 */
@RestController
@RequestMapping("/accounts")
public class AccountsController {
    private final EntityManager entities;

    public AccountsController(EntityManager entities) {
        this.entities = entities;
    }

    @SendproofPreview
    @PostMapping
    @Transactional
    public ResponseEntity<Map<String, String>> create(@RequestBody Map<String, String> body) {
        entities.persist(new Account(body.get("id"), body.get("email"), "hashed:" + body.get("password")));
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("id", body.get("id"), "email", body.get("email")));
    }

    @GetMapping("/{id}")
    @Transactional(readOnly = true)
    public ResponseEntity<Map<String, String>> get(@PathVariable String id) {
        Account account = entities.find(Account.class, id);
        return account == null ? ResponseEntity.notFound().build()
                : ResponseEntity.ok(Map.of("id", account.getId(), "email", account.getEmail()));
    }
}
