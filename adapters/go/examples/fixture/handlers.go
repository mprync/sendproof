package fixture

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/mprync/sendproof/adapters/go/sendproof"
)

// handlers holds the fixture's framework-neutral operations. Each framework
// binding routes to these, so the conformance run exercises that framework's own
// routing, middleware ordering and Sendproof marker.
type handlers struct {
	store  store
	logger *slog.Logger
}

// notifyCreated records the "created item" email and delivers it unless a preview
// suppresses it. Delivery is a log line: the fixture sends nothing.
func (h *handlers) notifyCreated(r *http.Request, id string) {
	ctx := r.Context()
	if sendproof.RecordEmail(ctx, "Created item", "bench@example.test", []string{"ops@example.test"}, "Created "+id, "Item "+id+" was created.") {
		return
	}
	h.logger.InfoContext(ctx, "delivered email for "+id)
}

func (h *handlers) create(w http.ResponseWriter, r *http.Request) {
	var body item
	if json.NewDecoder(r.Body).Decode(&body) != nil || strings.TrimSpace(body.ID) == "" || strings.TrimSpace(body.Name) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id and name are required"})
		return
	}
	ctx := r.Context()
	if err := h.store.insert(ctx, body.ID, body.Name); err != nil {
		h.fail(w, err)
		return
	}
	h.notifyCreated(r, body.ID)
	h.logger.InfoContext(ctx, "created:"+body.ID, "id", body.ID)
	if err := h.store.bindSecret(ctx); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, body)
}

func (h *handlers) read(w http.ResponseWriter, r *http.Request) {
	found, ok, err := h.store.get(r.Context(), r.PathValue("id"))
	switch {
	case err != nil:
		h.fail(w, err)
	case !ok:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	default:
		writeJSON(w, http.StatusOK, found)
	}
}

func (h *handlers) patch(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		Name string `json:"name"`
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil || strings.TrimSpace(body.Name) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}
	updated, err := h.store.update(r.Context(), id, body.Name)
	switch {
	case err != nil:
		h.fail(w, err)
		return
	case !updated:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if tag := r.URL.Query().Get("tag"); tag != "" {
		w.Header().Set("X-Fixture-Tag", tag)
	}
	writeJSON(w, http.StatusOK, item{ID: id, Name: body.Name})
}

func (h *handlers) remove(w http.ResponseWriter, r *http.Request) {
	if err := h.store.remove(r.Context(), r.PathValue("id")); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// failing inserts the item and then fails. By default it reports a handled 409;
// ?mode=exception panics, which a preview must report as an unconfirmed 500.
func (h *handlers) failing(w http.ResponseWriter, r *http.Request) {
	if err := h.store.insert(r.Context(), r.PathValue("id"), "Failing"); err != nil {
		h.fail(w, err)
		return
	}
	if r.URL.Query().Get("mode") == "exception" {
		panic("the fixture failed on purpose")
	}
	writeJSON(w, http.StatusConflict, map[string]string{"error": "the operation conflicted"})
}

// large inserts the item and returns a body over the preview response cap.
func (h *handlers) large(w http.ResponseWriter, r *http.Request) {
	if err := h.store.insert(r.Context(), r.PathValue("id"), "Large"); err != nil {
		h.fail(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte(strings.Repeat("x", 1100*1024)))
}

// redirect inserts the item and answers 302 with an inner Set-Cookie. A preview
// must neither follow the redirect nor forward the cookie.
func (h *handlers) redirect(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := h.store.insert(r.Context(), id, "Redirected"); err != nil {
		h.fail(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "inner", Value: "1", Path: "/"})
	http.Redirect(w, r, sendproof.PathBase(r)+"/items/"+id, http.StatusFound)
}

// capture exceeds every capture cap in one request: more than 200 changes, 100
// effects and 500 logs.
func (h *handlers) capture(w http.ResponseWriter, r *http.Request) {
	ctx, prefix := r.Context(), r.PathValue("id")
	for i := 0; i < 205; i++ {
		if err := h.store.insert(ctx, fmt.Sprintf("%s-%03d", prefix, i), "Captured"); err != nil {
			h.fail(w, err)
			return
		}
	}
	for i := 0; i < 105; i++ {
		sendproof.RecordMessage(ctx, "Queued message", "captured", map[string]any{"n": i})
	}
	for i := 0; i < 510; i++ {
		h.logger.InfoContext(ctx, fmt.Sprintf("capture line %d", i))
	}
	w.WriteHeader(http.StatusNoContent)
}

// ordinary inserts through plain Send only. It is deliberately not marked for Preview.
func (h *handlers) ordinary(w http.ResponseWriter, r *http.Request) {
	if err := h.store.insert(r.Context(), r.PathValue("id"), "Ordinary"); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *handlers) fail(w http.ResponseWriter, err error) {
	if err == errDuplicate {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	h.logger.Error("fixture request failed", "error", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}
