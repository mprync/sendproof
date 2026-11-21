package io.github.mprync.sendproof.jpa.testapp;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** An entity with a secret column, for checking that change snapshots and SQL hide it. */
@Entity
@Table(name = "logins")
public class Login {
    @Id
    private String id;
    @Column(name = "password_hash")
    private String passwordHash;
    /** A secret property whose column name isn't secret: redaction must still hide it. */
    @Column(name = "recovery")
    private String recoveryToken;
    /** Mapped by the naming strategy to {@code display_name}. */
    private String displayName;

    protected Login() {
    }

    public Login(String id, String passwordHash) {
        this.id = id;
        this.passwordHash = passwordHash;
        this.recoveryToken = passwordHash + "-recovery";
        this.displayName = "Login " + id;
    }

    public String getId() {
        return id;
    }

    public String getPasswordHash() {
        return passwordHash;
    }
}
