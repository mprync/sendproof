package chibench

import "testing"

func TestTemplate(t *testing.T) {
	for pattern, want := range map[string]string{
		"/items":              "/items",
		"/items/{id}":         "/items/{id}",
		"/items/{id:[0-9]+}":  "/items/{id}",
		"/files/*":            "/files/{path...}",
		"/a/{x:[a-z]+}/b/{y}": "/a/{x}/b/{y}",
	} {
		if got := Template(pattern); got != want {
			t.Errorf("Template(%q) = %q, want %q", pattern, got, want)
		}
	}
}
