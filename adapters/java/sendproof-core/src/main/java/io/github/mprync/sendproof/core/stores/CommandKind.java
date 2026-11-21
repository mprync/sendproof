package io.github.mprync.sendproof.core.stores;

/** How the guard treats one store command. Only {@link #WRITE} can block a Preview. */
public enum CommandKind {
    /** A command that only reads. */
    READ,
    /** A command that may change data. Everything a table does not list is a write. */
    WRITE,
    /** A connection-level command such as {@code AUTH}, {@code HELLO} or {@code PING}: never guarded or logged. */
    SESSION,
    /** A Redis transaction command ({@code MULTI}, {@code EXEC}, {@code DISCARD}, {@code WATCH}, {@code UNWATCH}). */
    TRANSACTION
}
