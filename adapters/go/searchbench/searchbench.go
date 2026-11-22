// Package searchbench guards Elasticsearch and OpenSearch clients for Sendproof
// Preview (spec/data-stores.md, store mode "guard"). It works for go-elasticsearch
// (v8 and later) and opensearch-go (v4 and later). Both clients send every request
// through an exported Transport field (the client's Perform interface), above
// their connection pool and retries, and the guard wraps that field:
//
//	es, _ := elasticsearch.NewClient(elasticsearch.Config{Addresses: []string{url}})
//	es.Transport = searchbench.ElasticsearchTransport(es.Transport) // also TypedClient and BaseClient
//	bench, _ := sendproof.New(sendproof.WithDataStore(searchbench.Store("articles")))
//
//	// OpenSearch reports itself as such:
//	os, _ := opensearchapi.NewClient(opensearchapi.Config{Client: opensearch.Config{Addresses: []string{url}}})
//	os.Client.Transport = searchbench.OpenSearchTransport(os.Client.Transport)
//	bench, _ := sendproof.New(sendproof.WithDataStore(searchbench.Store("articles", searchbench.OpenSearch())))
//
// Wrap the Transport right after building the client, before deriving other
// clients from it (elasticsearch.NewTypedFrom copies it).
//
// Reads run normally. During a Preview the first write is refused before the
// request is sent, with a *sendproof.PreviewWriteBlockedError, and the Preview
// answers HTTP 409 whatever the handler does with the error. The classification is
// the shared table in spec/data-stores/elasticsearch.json: an endpoint's method and
// path decide, so a POST to _search is a read and a _bulk is a write. Every other
// request becomes a Db log entry whose statement is the request body with every
// literal replaced by "?"; the path (which can hold document ids) is never logged.
//
// Because the refusal happens above the client's connection pool and retry logic,
// a refused write never marks a node dead and is never retried: other requests,
// including ordinary traffic outside any Preview, keep every node in rotation.
//
// # Bulk indexers
//
// A bulk indexer (esutil.BulkIndexer, opensearchutil.BulkIndexer) queues items and
// sends them later from its own goroutines, with a context that is not the
// request's. Wrap it with ElasticsearchBulkIndexer or OpenSearchBulkIndexer, so an
// item added during a Preview (or with no request while a Preview is open) is
// refused by Add, on the caller's goroutine, before it is queued. A raw indexer
// is guarded only when it sends: its flush is refused while some Preview is open,
// and a flush that runs after every Preview ended is sent.
//
// # Coverage
//
// The guard sees what the client sends through its Transport, so every method of
// the client, the typed client, bulk indexers, helpers and raw Perform calls are
// covered, and so are clients that share the wrapped Transport. Only clients whose
// Transport was wrapped are covered, and only calls made with the request's
// context: pass r.Context() (or a context derived from it) to every call. A client
// built without the wrapper and a second client for the same cluster are not
// guarded. A request made with context.Background() while a Preview is open is
// refused before it is sent and blocks every open Preview, like a client's own
// background goroutine (mark background work with sendproof.Detached). A request
// carrying the context of a Preview that has ended, such as from a goroutine the
// handler started, is refused for as long as the process runs.
package searchbench

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/elastic/elastic-transport-go/v8/elastictransport"
	"github.com/elastic/go-elasticsearch/v8/esutil"
	"github.com/opensearch-project/opensearch-go/v4"
	"github.com/opensearch-project/opensearch-go/v4/opensearchtransport"
	"github.com/opensearch-project/opensearch-go/v4/opensearchutil"

	"github.com/mprync/sendproof/adapters/go/sendproof"
	"github.com/mprync/sendproof/adapters/go/stores"
)

// Engine is the store id the guard reports: the table is shared, the name is not.
type Engine string

const (
	// ElasticsearchEngine is the store id "elasticsearch".
	ElasticsearchEngine Engine = "elasticsearch"
	// OpenSearchEngine is the store id "opensearch".
	OpenSearchEngine Engine = "opensearch"
)

// maxBody is the largest request body the guard reads. A SQL request larger than
// this is refused as a write; a larger body of any other request is sent without a
// statement in its Db entry.
const maxBody = 1 << 20

// bulkOperation is the table's name for _bulk, the operation a bulk indexer's
// queued item becomes.
const bulkOperation = "bulk"

// Option configures Store, the transports and the bulk indexers.
type Option func(*settings)

type settings struct {
	engine Engine
}

// OpenSearch makes the guard report the store as "opensearch", in Db entries, the
// 409 body and discovery. Pass it to Store for an OpenSearch cluster;
// OpenSearchTransport and OpenSearchBulkIndexer report "opensearch" already.
func OpenSearch() Option { return func(s *settings) { s.engine = OpenSearchEngine } }

func configure(engine Engine, options []Option) settings {
	config := settings{engine: engine}
	for _, option := range options {
		option(&config)
	}
	return config
}

// Store returns the data store for sendproof.WithDataStore. name is an optional
// display label for discovery, such as "articles": never a URL or host name. It
// panics on a label that looks like connection details. Pass OpenSearch() for an
// OpenSearch cluster.
func Store(name string, options ...Option) sendproof.DataStore {
	label, err := stores.Label(name)
	if err != nil {
		panic(err)
	}
	return &store{name: label, system: string(configure(ElasticsearchEngine, options).engine)}
}

// store is the discovery entry of a hooked cluster. Neither engine has a rollback,
// so it prepares nothing per Preview.
type store struct{ name, system string }

func (s *store) Describe(context.Context) sendproof.DataStoreInfo {
	return sendproof.DataStoreInfo{System: s.system, Name: s.name, Mode: sendproof.ModeGuard}
}

func (s *store) BeginPreview(context.Context) (sendproof.StorePreview, error) { return nil, nil }

// ---- Transports ----

// ElasticsearchTransport guards next, a go-elasticsearch client's Transport field:
//
//	es.Transport = searchbench.ElasticsearchTransport(es.Transport)
//
// The result keeps the client's Metrics, DiscoverNodes, Close and instrumentation
// working. Wrapping a Transport twice returns it unchanged.
func ElasticsearchTransport(next elastictransport.Interface, options ...Option) elastictransport.Interface {
	if wrapped, ok := next.(*esTransport); ok {
		return wrapped
	}
	return &esTransport{next: next, guard: guard{system: string(configure(ElasticsearchEngine, options).engine)}}
}

// OpenSearchTransport guards next, an opensearch-go client's Transport field:
//
//	client.Client.Transport = searchbench.OpenSearchTransport(client.Client.Transport)
//
// The result keeps the client's Stream, Metrics, DiscoverNodes and Close working.
// Wrapping a Transport twice returns it unchanged.
func OpenSearchTransport(next opensearchtransport.Interface, options ...Option) opensearchtransport.Interface {
	if wrapped, ok := next.(*osTransport); ok {
		return wrapped
	}
	return &osTransport{next: next, guard: guard{system: string(configure(OpenSearchEngine, options).engine)}}
}

// esTransport is the guarded go-elasticsearch Transport.
type esTransport struct {
	next elastictransport.Interface
	guard
}

func (t *esTransport) Perform(req *http.Request) (*http.Response, error) {
	return t.guard.do(req, t.next.Perform)
}

// InstrumentationEnabled forwards to the wrapped Transport (elastictransport.Instrumented).
func (t *esTransport) InstrumentationEnabled() elastictransport.Instrumentation {
	if inner, ok := t.next.(elastictransport.Instrumented); ok {
		return inner.InstrumentationEnabled()
	}
	return nil
}

// Close forwards to the wrapped Transport (elastictransport.Closeable).
func (t *esTransport) Close(ctx context.Context) error {
	if inner, ok := t.next.(elastictransport.Closeable); ok {
		return inner.Close(ctx)
	}
	return nil
}

// Metrics forwards to the wrapped Transport (elastictransport.Measurable).
func (t *esTransport) Metrics() (elastictransport.Metrics, error) {
	if inner, ok := t.next.(elastictransport.Measurable); ok {
		return inner.Metrics()
	}
	return elastictransport.Metrics{}, errMissing("Metrics")
}

// DiscoverNodes forwards to the wrapped Transport (elastictransport.Discoverable).
func (t *esTransport) DiscoverNodes() error {
	if inner, ok := t.next.(elastictransport.Discoverable); ok {
		return inner.DiscoverNodes()
	}
	return errMissing("DiscoverNodes")
}

// osTransport is the guarded opensearch-go Transport.
type osTransport struct {
	next opensearchtransport.Interface
	guard
}

func (t *osTransport) Perform(req *http.Request) (*http.Response, error) {
	return t.guard.do(req, t.next.Perform)
}

// Stream guards and forwards to the wrapped Transport (opensearch.Streamer).
func (t *osTransport) Stream(req *http.Request) (*http.Response, error) {
	inner, ok := t.next.(opensearch.Streamer)
	if !ok {
		return nil, opensearch.ErrTransportMissingMethodStream
	}
	return t.guard.do(req, inner.Stream)
}

// Close forwards to the wrapped Transport (io.Closer).
func (t *osTransport) Close() error {
	if inner, ok := t.next.(io.Closer); ok {
		return inner.Close()
	}
	return nil
}

// Metrics forwards to the wrapped Transport (opensearchtransport.Measurable).
func (t *osTransport) Metrics() (opensearchtransport.Metrics, error) {
	if inner, ok := t.next.(opensearchtransport.Measurable); ok {
		return inner.Metrics()
	}
	return opensearchtransport.Metrics{}, opensearch.ErrTransportMissingMethodMetrics
}

// DiscoverNodes forwards to the wrapped Transport (opensearchtransport.Discoverable).
func (t *osTransport) DiscoverNodes(ctx context.Context) error {
	if inner, ok := t.next.(opensearchtransport.Discoverable); ok {
		return inner.DiscoverNodes(ctx)
	}
	return opensearch.ErrTransportMissingMethodDiscoverNodes
}

type missingMethod string

func (m missingMethod) Error() string { return "transport is missing method " + string(m) + "()" }

func errMissing(method string) error { return missingMethod(method) }

// guard classifies, refuses and logs requests for both clients.
type guard struct{ system string }

// do classifies the request before send runs. A refused write is returned as an
// error with the body closed; send, and so the pool and its retries, never see it.
func (g guard) do(req *http.Request, send func(*http.Request) (*http.Response, error)) (*http.Response, error) {
	ctx := req.Context()
	target := req.URL.EscapedPath()
	// An unreadable body (too large or bad gzip) classifies as nil: a SQL endpoint
	// then reads as a write, because only a readable body can prove it a read.
	body, readable := readBody(req)
	decision := stores.ClassifySearch(stores.SearchRequest{Method: req.Method, Target: target, Body: body})
	if err := sendproof.Guard(ctx, g.system, decision.Operation, decision.Kind == stores.Write, ""); err != nil {
		if req.Body != nil {
			_ = req.Body.Close()
		}
		return nil, err
	}
	started := time.Now()
	resp, err := send(req)
	if decision.Kind != stores.Session {
		g.record(ctx, decision, target, body, readable, started, resp, err)
	}
	return resp, err
}

// record logs the request as a Db entry. The statement is the sanitized body, and
// the target the index the path names.
func (g guard) record(ctx context.Context, decision stores.Decision, target string, body []byte, readable bool, started time.Time, resp *http.Response, failure error) {
	call := sendproof.DbCall{
		System: g.system, Operation: decision.Operation, Target: stores.SearchTarget(target),
		RowsAffected: sendproof.UnknownRows, Duration: time.Since(started),
	}
	if readable {
		call.Statement = stores.SanitizeJSON(body)
	}
	switch {
	case failure != nil:
		call.Error = "Error"
	case resp != nil && resp.StatusCode >= 400:
		call.Error = strconv.Itoa(resp.StatusCode)
	}
	sendproof.RecordDb(ctx, call)
}

// readBody returns the request body for classification and logging, and puts it
// back so the request can still be sent (and retried: GetBody is kept). It reads at
// most maxBody bytes; a larger or unreadable body returns readable=false and the
// request is sent with its body intact. A gzip body is decompressed for the
// guard's copy only.
func readBody(req *http.Request) (body []byte, readable bool) {
	if req.Body == nil || req.Body == http.NoBody {
		return nil, true
	}
	raw, err := io.ReadAll(io.LimitReader(req.Body, maxBody+1))
	if err != nil || len(raw) > maxBody {
		// Put back what was read and what remains; the guard has no copy to classify.
		rest := req.Body
		req.Body = struct {
			io.Reader
			io.Closer
		}{io.MultiReader(bytes.NewReader(raw), rest), rest}
		return nil, false
	}
	_ = req.Body.Close()
	req.Body = io.NopCloser(bytes.NewReader(raw))
	req.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(raw)), nil }
	if strings.EqualFold(req.Header.Get("Content-Encoding"), "gzip") {
		reader, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, false
		}
		plain, err := io.ReadAll(io.LimitReader(reader, maxBody+1))
		if err != nil || len(plain) > maxBody {
			return nil, false
		}
		return plain, true
	}
	return raw, true
}

// ---- Bulk indexers ----

// ElasticsearchBulkIndexer guards a go-elasticsearch bulk indexer: Add refuses an
// item during a Preview, or with no request while a Preview is open, before it is
// queued, on the caller's goroutine. Every bulk item is a write.
//
//	indexer, _ := esutil.NewBulkIndexer(esutil.BulkIndexerConfig{Client: es, Index: "articles"})
//	indexer = searchbench.ElasticsearchBulkIndexer(indexer)
func ElasticsearchBulkIndexer(indexer esutil.BulkIndexer, options ...Option) esutil.BulkIndexer {
	return &esBulkIndexer{BulkIndexer: indexer, system: string(configure(ElasticsearchEngine, options).engine)}
}

// OpenSearchBulkIndexer guards an opensearch-go bulk indexer like
// ElasticsearchBulkIndexer.
func OpenSearchBulkIndexer(indexer opensearchutil.BulkIndexer, options ...Option) opensearchutil.BulkIndexer {
	return &osBulkIndexer{BulkIndexer: indexer, system: string(configure(OpenSearchEngine, options).engine)}
}

type esBulkIndexer struct {
	esutil.BulkIndexer
	system string
}

func (b *esBulkIndexer) Add(ctx context.Context, item esutil.BulkIndexerItem) error {
	if err := sendproof.Guard(ctx, b.system, bulkOperation, true, ""); err != nil {
		return err
	}
	return b.BulkIndexer.Add(ctx, item)
}

type osBulkIndexer struct {
	opensearchutil.BulkIndexer
	system string
}

func (b *osBulkIndexer) Add(ctx context.Context, item opensearchutil.BulkIndexerItem) error {
	if err := sendproof.Guard(ctx, b.system, bulkOperation, true, ""); err != nil {
		return err
	}
	return b.BulkIndexer.Add(ctx, item)
}
