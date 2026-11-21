package io.github.mprync.sendproof.mongodb;

/**
 * Makes a Preview's session ambient for a framework that finds its session on the thread, such as Spring Data
 * MongoDB's transaction synchronization. Called on the request thread: {@link #bind} before the handler runs, and
 * {@link #unbind} when the Preview ends.
 */
public interface SessionBinder {

    /** A binder that does nothing, for guarded handles that inject the session themselves. */
    SessionBinder NONE = new SessionBinder() {
        @Override
        public void bind(Object session) {
            // Nothing to bind.
        }

        @Override
        public void unbind() {
            // Nothing to unbind.
        }
    };

    /** Makes {@code session}, the Preview's guarded driver session, the ambient session of this thread. */
    void bind(Object session);

    /** Removes what {@link #bind} made ambient. Must be safe to call when nothing was bound. */
    void unbind();
}
