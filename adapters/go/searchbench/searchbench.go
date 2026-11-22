// Package searchbench guards Elasticsearch and OpenSearch clients for Sendproof
// Preview (spec/data-stores.md, store mode "guard"). It works for go-elasticsearch
// (v8 and later) and opensearch-go (v4 and later) alike, because both take an
// http.RoundTripper: the guard is a RoundTripper wrapper, set as the client's
// Transport.
//
//	es, _ := elasticsearch.NewClient(elasticsearch.Config{
//	    Addresses: []string{url},
//	    Transport: searchbench.Transport(nil), // nil wraps http.DefaultTransport
//	})
//	bench, _ := sendproof.New(sendproof.WithDataStore(searchbench.Store("articles")))
//
//	// OpenSearch reports itself as such:
//	os, _ := opensearchapi.NewClient(opensearchapi.Config{Client: opensearch.Config{
//	    Addresses: []string{url},
//	    Transport: searchbench.Transport(nil, searchbench.OpenSearch()),
//	}})
//
// Reads run normally. During a Preview the first write is refused before the
// request is sent, with a *sendproof.PreviewWriteBlockedError, and the Preview
// answers HTTP 409 whatever the handler does with the error. The classification is
// the shared table in spec/data-stores/elasticsearch.json: an endpoint's method and
// path decide, so a POST to _search is a read and a _bulk is a write. Every other
// request becomes a Db log entry whose statement is the request body with every
// literal replaced by "?"; the path (which can hold document ids) is never logged.
//
// # Coverage
//
// The wrapper sees what the client sends, below the typed API, so every method of
// the client, the typed client, bulk indexers and helpers are covered, and so are
// clients derived from the configured one. Only clients built with the wrapper are
// covered, and only calls made with the request's context: pass r.Context() (or a
// context derived from it) to every call. A client built without the wrapper, a
// second client for the same cluster and a request made with context.Background()
// are not guarded; the last one, while a Preview is open, is refused before it is
// sent and blocks every open Preview, like a client's own background goroutine
// (mark background work with sendproof.Detached).
//
// A refusal is an error from the transport, so the clients' connection pools
// treat it as a failed node: with several nodes configured, each refused write
// takes one node out of rotation until the client's resurrection timer puts it
// back, and with default retries the client asks the guard again (every attempt is
// refused and nothing is sent). A refusal ends its Preview, so this only affects
// the handful of requests that run before it.
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

	"github.com/mprync/sendproof/adapters/go/sendproof"
	"github.com/mprync/sendproof/adapters/go/stores"
)

// Engine is the store id the guard reports: the table is shared, the name is not.
type Engine string

const (
	// ElasticsearchEngine is the store id "elasticsearch", the default.
	ElasticsearchEngine Engine = "elasticsearch"
	// OpenSearchEngine is the store id "opensearch".
	OpenSearchEngine Engine = "opensearch"
)

// maxBody is the largest request body the guard reads. A SQL request larger than
// this is refused as a write; a larger body of any other request is sent without a
// statement in its Db entry.
const maxBody = 1 << 20

// Option configures Transport and Store.
type Option func(*settings)

type settings struct {
	engine Engine
	prefix string
}

// OpenSearch makes the guard report the store as "opensearch" (the default is
// "elasticsearch"), in Db entries, the 409 body and discovery. Pass it to both
// Transport and Store.
func OpenSearch() Option { return func(s *settings) { s.engine = OpenSearchEngine } }

// PathPrefix names the path prefix the client is configured with, such as "/search"
// for a cluster behind a proxy at https://host/search. The guard removes it before
// it classifies the path. Without it a prefixed request matches no table entry, so a
// GET reads and every other method is a write: it fails closed, but a POST to
// _search is then refused as a write.
func PathPrefix(prefix string) Option {
	return func(s *settings) { s.prefix = "/" + strings.Trim(prefix, "/") }
}

func configure(options []Option) settings {
	config := settings{engine: ElasticsearchEngine}
	for _, option := range options {
		option(&config)
	}
	return config
}

// Transport returns an http.RoundTripper that guards and logs every request and
// then sends it with next (http.DefaultTransport when next is nil). Set it as the
// client's Transport. Wrap the transport you would have used anyway, so TLS and
// proxy settings still apply.
func Transport(next http.RoundTripper, options ...Option) http.RoundTripper {
	if next == nil {
		next = http.DefaultTransport
	}
	config := configure(options)
	return &guard{next: next, system: string(config.engine), prefix: config.prefix}
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
	return &store{name: label, system: string(configure(options).engine)}
}

// store is the discovery entry of a hooked cluster. Neither engine has a rollback,
// so it prepares nothing per Preview.
type store struct{ name, system string }

func (s *store) Describe(context.Context) sendproof.DataStoreInfo {
	return sendproof.DataStoreInfo{System: s.system, Name: s.name, Mode: sendproof.ModeGuard}
}

func (s *store) BeginPreview(context.Context) (sendproof.StorePreview, error) { return nil, nil }

// guard is the RoundTripper.
type guard struct {
	next   http.RoundTripper
	system string
	prefix string
}

// RoundTrip classifies the request before it is sent. A refused write is returned
// as an error with the body closed, as the RoundTripper contract requires.
func (g *guard) RoundTrip(req *http.Request) (*http.Response, error) {
	ctx := req.Context()
	path := req.URL.EscapedPath()
	if g.prefix != "" && g.prefix != "/" {
		if trimmed, ok := strings.CutPrefix(path, g.prefix); ok && (trimmed == "" || trimmed[0] == '/') {
			path = trimmed
		}
	}
	target := path
	// An unreadable body (too large or bad gzip) classifies as nil: a SQL endpoint
	// then reads as a write, because only a readable body can prove it a read.
	body, readable := g.readBody(req)
	decision := stores.ClassifySearch(stores.SearchRequest{Method: req.Method, Target: target, Body: body})
	if err := sendproof.Guard(ctx, g.system, decision.Operation, decision.Kind == stores.Write, ""); err != nil {
		if req.Body != nil {
			_ = req.Body.Close()
		}
		return nil, err
	}
	started := time.Now()
	resp, err := g.next.RoundTrip(req)
	if decision.Kind != stores.Session {
		g.record(ctx, decision, target, body, readable, started, resp, err)
	}
	return resp, err
}

// record logs the request as a Db entry. The statement is the sanitized body, and
// the target the index the path names.
func (g *guard) record(ctx context.Context, decision stores.Decision, target string, body []byte, readable bool, started time.Time, resp *http.Response, failure error) {
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
func (g *guard) readBody(req *http.Request) (body []byte, readable bool) {
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
