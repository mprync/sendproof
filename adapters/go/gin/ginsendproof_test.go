package ginsendproof

import "testing"

func TestTemplate(t *testing.T) {
	for path, want := range map[string]string{
		"/items":           "/items",
		"/items/:id":       "/items/{id}",
		"/a/:x/b/:y":       "/a/{x}/b/{y}",
		"/files/*filepath": "/files/{filepath...}",
		"/files/*":         "/files/{path...}",
	} {
		if got := Template(path); got != want {
			t.Errorf("Template(%q) = %q, want %q", path, got, want)
		}
	}
}
