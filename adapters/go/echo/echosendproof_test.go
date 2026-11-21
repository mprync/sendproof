package echosendproof

import "testing"

func TestTemplate(t *testing.T) {
	for path, want := range map[string]string{
		"/items":     "/items",
		"/items/:id": "/items/{id}",
		"/files/*":   "/files/{path...}",
	} {
		if got := Template(path); got != want {
			t.Errorf("Template(%q) = %q, want %q", path, got, want)
		}
	}
}
