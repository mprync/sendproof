package io.github.mprync.sendproof.fixture;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** A row of the fixture's only table, {@code items}. */
@Entity
@Table(name = "items")
public class Item {

    @Id
    @Column(name = "id")
    private String id;

    @Column(name = "name")
    private String name;

    protected Item() {
    }

    public Item(String id, String name) {
        this.id = id;
        this.name = name;
    }

    public String getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }
}
