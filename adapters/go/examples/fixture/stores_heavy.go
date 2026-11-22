package fixture

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
	"github.com/opensearch-project/opensearch-go/v4"
	"github.com/opensearch-project/opensearch-go/v4/opensearchapi"

	"github.com/mprync/sendproof/adapters/go/cassandrabench"
	"github.com/mprync/sendproof/adapters/go/searchbench"
)

// The Cassandra and OpenSearch routes of spec/conformance/fixture.md, "Data store
// routes". Both stores run in guard mode and come from the compose heavy-stores
// profile; each is hooked only when the runner passed its variables.

// openCassandra connects through the guard, so the fixture holds no raw session.
func (d *dataStores) openCassandra(contactPoint, keyspace string) error {
	host, port, _ := strings.Cut(contactPoint, ":")
	cluster := gocql.NewCluster(host)
	if port != "" {
		var number int
		for _, digit := range port {
			number = number*10 + int(digit-'0')
		}
		cluster.Port = number
	}
	cluster.Keyspace = keyspace
	cluster.Consistency = gocql.One
	// The contact point is the compose service's published port; the address the
	// node reports for itself is its container address, which is not reachable.
	cluster.DisableInitialHostLookup = true
	session, err := cassandrabench.Connect(cluster)
	if err != nil {
		return err
	}
	d.cassandra = session
	d.registered = append(d.registered, cassandrabench.Store("tickets"))
	return nil
}

// openOpenSearch builds the client and guards its Transport, above the pool.
func (d *dataStores) openOpenSearch(url, index string) error {
	client, err := opensearchapi.NewClient(opensearchapi.Config{Client: opensearch.Config{Addresses: []string{url}}})
	if err != nil {
		return err
	}
	client.Client.Transport = searchbench.OpenSearchTransport(client.Client.Transport)
	d.opensearch, d.opensearchIndex = client, index
	d.registered = append(d.registered, searchbench.Store("articles", searchbench.OpenSearch()))
	return nil
}

// closeHeavy releases the heavy stores' clients.
func (d *dataStores) closeHeavy() {
	if d.cassandra != nil {
		d.cassandra.Close()
	}
}

// heavyRoutes lists the routes of the heavy stores that are hooked.
func (d *dataStores) heavyRoutes() []route {
	var list []route
	if d.cassandra != nil {
		list = append(list,
			route{method: "GET", path: "/tickets/{id}", preview: true, handler: func(h *handlers) http.HandlerFunc { return h.stores.readTicket }},
			route{method: "POST", path: "/tickets/{id}/touch", admin: true, preview: true, handler: func(h *handlers) http.HandlerFunc { return h.stores.touchTicketRoute }},
			route{method: "POST", path: "/tickets/{id}/close", admin: true, preview: true, handler: func(h *handlers) http.HandlerFunc { return h.stores.closeTicket }},
			route{method: "DELETE", path: "/tickets/{id}", admin: true, store: "cassandra", handler: func(h *handlers) http.HandlerFunc { return h.stores.deleteTicket }},
		)
	}
	if d.opensearch != nil {
		list = append(list,
			route{method: "GET", path: "/articles/{id}", preview: true, handler: func(h *handlers) http.HandlerFunc { return h.stores.readArticle }},
			route{method: "POST", path: "/articles/{id}/touch", admin: true, preview: true, handler: func(h *handlers) http.HandlerFunc { return h.stores.touchArticleRoute }},
			route{method: "POST", path: "/articles/{id}/hide", admin: true, preview: true, handler: func(h *handlers) http.HandlerFunc { return h.stores.hideArticle }},
			route{method: "DELETE", path: "/articles/{id}", admin: true, store: "opensearch", handler: func(h *handlers) http.HandlerFunc { return h.stores.deleteArticle }},
		)
	}
	return list
}

// ---- Cassandra ----

// readTicket runs a prepared SELECT: gocql prepares it, and the guard classifies the
// text it was prepared from.
func (d *dataStores) readTicket(w http.ResponseWriter, r *http.Request) {
	var id, status string
	var hits int
	err := d.cassandra.Query(`SELECT id, status, hits FROM tickets WHERE id = ?`, r.PathValue("id")).WithContext(r.Context()).Scan(&id, &status, &hits)
	switch {
	case errors.Is(err, gocql.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	case err != nil:
		storeFailure(w, err)
	default:
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": status, "hits": hits})
	}
}

// touchTicket is the INSERT the contract describes; the "remember" route reuses it.
func (d *dataStores) touchTicket(ctx context.Context, id string) error {
	return d.cassandra.Query(`INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)`, id).WithContext(ctx).Exec()
}

func (d *dataStores) touchTicketRoute(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := d.touchTicket(r.Context(), id); err != nil {
		storeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": "new", "hits": 1})
}

// closeTicket sends one logged batch holding a lightweight transaction: a batch is
// always a write, so a Preview refuses it before it is sent.
func (d *dataStores) closeTicket(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	batch := d.cassandra.Batch(gocql.LoggedBatch).WithContext(r.Context())
	batch.Query(`UPDATE tickets SET status = 'closed' WHERE id = ? IF EXISTS`, id)
	if err := batch.Exec(); err != nil {
		storeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": "closed"})
}

func (d *dataStores) deleteTicket(w http.ResponseWriter, r *http.Request) {
	if err := d.cassandra.Query(`DELETE FROM tickets WHERE id = ?`, r.PathValue("id")).WithContext(r.Context()).Exec(); err != nil {
		storeFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- OpenSearch ----

// idQuery is the body of a search or update-by-query that matches one document id.
func idQuery(id string, extra map[string]any) *strings.Reader {
	body := map[string]any{"query": map[string]any{"ids": map[string]any{"values": []string{id}}}}
	for key, value := range extra {
		body[key] = value
	}
	encoded, _ := json.Marshal(body)
	return strings.NewReader(string(encoded))
}

// article is a document's {title, views}.
type article struct {
	Title string `json:"title"`
	Views int    `json:"views"`
}

func articleReply(w http.ResponseWriter, id string, source json.RawMessage) {
	var found article
	_ = json.Unmarshal(source, &found)
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "title": found.Title, "views": found.Views})
}

// readArticle reads with a POST _search: a read sent as a POST.
func (d *dataStores) readArticle(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	response, err := d.opensearch.Search(r.Context(), &opensearchapi.SearchReq{Indices: []string{d.opensearchIndex}, Body: idQuery(id, map[string]any{"size": 1})})
	switch {
	case err != nil:
		storeFailure(w, err)
	case len(response.Hits.Hits) == 0:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	default:
		articleReply(w, id, response.Hits.Hits[0].Source)
	}
}

// touchArticle is the scripted update with an upsert the contract describes; the
// "remember" route reuses it.
func (d *dataStores) touchArticle(ctx context.Context, id string) (json.RawMessage, error) {
	body, _ := json.Marshal(map[string]any{
		"script":  map[string]any{"source": "ctx._source.views += params.step", "params": map[string]any{"step": 1}},
		"upsert":  map[string]any{"title": "Untitled", "views": 1},
		"_source": true,
	})
	response, err := d.opensearch.Update(ctx, opensearchapi.UpdateReq{
		Index: d.opensearchIndex, DocumentID: id, Body: strings.NewReader(string(body)),
		Params: opensearchapi.UpdateParams{Refresh: "true"},
	})
	if err != nil {
		return nil, err
	}
	if response.Get == nil {
		return nil, errors.New("the update reply carries no document")
	}
	return response.Get.Source, nil
}

func (d *dataStores) touchArticleRoute(w http.ResponseWriter, r *http.Request) {
	source, err := d.touchArticle(r.Context(), r.PathValue("id"))
	if err != nil {
		storeFailure(w, err)
		return
	}
	articleReply(w, r.PathValue("id"), source)
}

// hideArticle runs an update-by-query and reports any store error as a 404: it
// catches the refusal, and the Preview must still answer 409.
func (d *dataStores) hideArticle(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	body := idQuery(id, map[string]any{"script": map[string]any{"source": "ctx._source.hidden = true"}})
	response, err := d.opensearch.UpdateByQuery(r.Context(), opensearchapi.UpdateByQueryReq{
		Indices: []string{d.opensearchIndex}, Body: body, Params: opensearchapi.UpdateByQueryParams{Refresh: opensearchapi.ToPointer(true)},
	})
	if err != nil || response.Updated == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "hidden": true})
}

func (d *dataStores) deleteArticle(w http.ResponseWriter, r *http.Request) {
	if _, err := d.opensearch.Document.Delete(r.Context(), opensearchapi.DocumentDeleteReq{
		Index: d.opensearchIndex, DocumentID: r.PathValue("id"), Params: opensearchapi.DocumentDeleteParams{Refresh: "true"},
	}); err != nil {
		storeFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// openHeavyStores connects the heavy stores whose variables are set.
func (d *dataStores) openHeavyStores() error {
	if point := os.Getenv("BENCH_CASSANDRA_CONTACT_POINT"); point != "" {
		if err := d.openCassandra(point, os.Getenv("BENCH_CASSANDRA_KEYSPACE")); err != nil {
			return err
		}
	}
	if url := os.Getenv("BENCH_OPENSEARCH_URL"); url != "" {
		if err := d.openOpenSearch(url, os.Getenv("BENCH_OPENSEARCH_INDEX")); err != nil {
			return err
		}
	}
	return nil
}
