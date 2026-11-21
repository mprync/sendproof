// Package chisendproof marks go-chi routes for Sendproof Preview.
//
// Wrap the whole router with sendproof.Sendproof.Middleware outside chi, so a preview
// is routed and authenticated by chi like the real request:
//
//	r := chi.NewRouter()
//	r.With(chisendproof.Preview(bench, http.MethodPost, "/items/{id}")).
//		Post("/items/{id}", createItem)
//	http.ListenAndServe(addr, bench.Middleware(r))
package chisendproof

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/mprync/sendproof/adapters/go/sendproof"
)

var constraint = regexp.MustCompile(`\{([^}:]+):[^}]*\}`)

// Template converts a chi route pattern into the OpenAPI path template that
// Sendproof advertises: regular-expression constraints are dropped and a
// trailing * becomes a wildcard parameter.
func Template(pattern string) string {
	template := constraint.ReplaceAllString(pattern, "{$1}")
	if strings.HasSuffix(template, "/*") {
		template = strings.TrimSuffix(template, "*") + "{path...}"
	}
	return template
}

// Preview marks a chi route as eligible for Preview and observed Send. Pass the
// full route path, including the prefix of any enclosing r.Route group, because a
// chi middleware cannot see the prefix. Use it with Router.With on the route.
func Preview(bench *sendproof.Sendproof, method, pattern string) func(http.Handler) http.Handler {
	return bench.Operation(method, Template(pattern)).Middleware()
}
