// Package ginsendproof marks Gin routes for Sendproof Preview.
//
// Wrap the Gin engine with sendproof.Sendproof.Middleware, not engine.Use: a preview
// must be routed by Gin itself, which happens before engine middleware runs.
//
//	r := gin.New()
//	r.POST("/items/:id", ginsendproof.Preview(bench, http.MethodPost, "/items/:id"), createItem)
//	http.ListenAndServe(addr, bench.Middleware(r))
package ginsendproof

import (
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/mprync/sendproof/adapters/go/sendproof"
)

var param = regexp.MustCompile(`:([A-Za-z0-9_]+)`)

// Template converts a Gin route path into the OpenAPI path template that Test
// Sendproof advertises.
func Template(path string) string {
	template := param.ReplaceAllString(path, "{$1}")
	if index := strings.LastIndex(template, "/*"); index >= 0 {
		name := template[index+2:]
		if name == "" {
			name = "path"
		}
		template = template[:index] + "/{" + name + "...}"
	}
	return template
}

// Preview returns the route marker. Put it before the route's handler. Pass the
// full route path, including the prefix of any enclosing router group.
func Preview(bench *sendproof.Sendproof, method, path string) gin.HandlerFunc {
	operation := bench.Operation(method, Template(path))
	return func(c *gin.Context) {
		if !operation.Enter(c.Writer, c.Request) {
			c.Abort()
			return
		}
		c.Next()
		if !c.IsAborted() {
			operation.Complete(c.Request)
		}
	}
}
