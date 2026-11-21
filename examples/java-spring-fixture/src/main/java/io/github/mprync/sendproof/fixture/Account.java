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

    /** Reported by its column name, {@code password_hash}, which the shared secret-columns check reads. */
    @Column(name = "password_hash")
    private String passwordHash;

    protected Account() {
    }

    public Account(String id, String email, String passwordHash) {
        this.id = id;
        this.email = email;
        this.passwordHash = passwordHash;
    }

    public String getId() {
        return id;
    }

    public String getEmail() {
        return email;
    }

    public String getPasswordHash() {
        return passwordHash;
    }
}
