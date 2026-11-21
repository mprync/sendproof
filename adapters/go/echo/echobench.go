// Package echobench marks Echo routes for Test Bench Preview.
//
// Wrap the Echo instance with testbench.Bench.Middleware, so a preview is routed
// and authenticated by Echo like the real request:
//
//	e := echo.New()
//	e.POST("/items/:id", createItem, echobench.Preview(bench, http.MethodPost, "/items/:id"))
//	http.ListenAndServe(addr, bench.Middleware(e))
package echobench

import (
	"regexp"
	"strings"

	"github.com/labstack/echo/v4"

	"github.com/test-bench/test-bench/adapters/go/testbench"
)

var param = regexp.MustCompile(`:([A-Za-z0-9_]+)`)

// Template converts an Echo route path into the OpenAPI path template that Test
// Bench advertises.
func Template(path string) string {
	template := param.ReplaceAllString(path, "{$1}")
	if strings.HasSuffix(template, "/*") {
		template = strings.TrimSuffix(template, "*") + "{path...}"
	}
	return template
}

// Preview returns the route marker for use as route middleware. Pass the full
// route path, including the prefix of any enclosing group.
func Preview(bench *testbench.Bench, method, path string) echo.MiddlewareFunc {
	operation := bench.Operation(method, Template(path))
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if !operation.Enter(c.Response(), c.Request()) {
				return nil
			}
			err := next(c)
			if err == nil {
				// An error is not a completed handler: Echo will render it after
				// this middleware returns, and a preview must not confirm that.
				operation.Complete(c.Request())
			}
			return err
		}
	}
}
