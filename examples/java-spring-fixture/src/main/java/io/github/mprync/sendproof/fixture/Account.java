package io.github.mprync.sendproof.fixture;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** A row of the fixture's second table, {@code accounts}, which holds a secret-named column. */
@Entity
@Table(name = "accounts")
public class Account {

    @Id
    @Column(name = "id")
    private String id;

    @Column(name = "email")
    private String email;

    /**
     * Named after its column: the Java binding reports a JPA row by property name, and the shared secret-columns check
     * reads {@code after.password_hash}.
     */
    @Column(name = "password_hash")
    private String password_hash;

    protected Account() {
    }

    public Account(String id, String email, String passwordHash) {
        this.id = id;
        this.email = email;
        this.password_hash = passwordHash;
    }

    public String getId() {
        return id;
    }

    public String getEmail() {
        return email;
    }

    public String getPasswordHash() {
        return password_hash;
    }
}
