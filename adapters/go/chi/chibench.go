// Package chibench marks go-chi routes for Test Bench Preview.
//
// Wrap the whole router with testbench.Bench.Middleware outside chi, so a preview
// is routed and authenticated by chi like the real request:
//
//	r := chi.NewRouter()
//	r.With(chibench.Preview(bench, http.MethodPost, "/items/{id}")).
//		Post("/items/{id}", createItem)
//	http.ListenAndServe(addr, bench.Middleware(r))
package chibench

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/test-bench/test-bench/adapters/go/testbench"
)

var constraint = regexp.MustCompile(`\{([^}:]+):[^}]*\}`)

// Template converts a chi route pattern into the OpenAPI path template that
// Test Bench advertises: regular-expression constraints are dropped and a
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
func Preview(bench *testbench.Bench, method, pattern string) func(http.Handler) http.Handler {
	return bench.Operation(method, Template(pattern)).Middleware()
}
