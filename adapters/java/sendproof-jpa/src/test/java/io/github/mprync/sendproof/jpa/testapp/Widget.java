package io.github.mprync.sendproof.jpa.testapp;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "widgets")
public class Widget {
    @Id
    private String id;
    private String name;

    protected Widget() {
    }

    public Widget(String id, String name) {
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
