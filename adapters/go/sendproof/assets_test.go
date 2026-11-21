package sendproof

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"testing"

	"github.com/mprync/sendproof/adapters/go/internal/ui"
)

// TestEmbeddedUIMatchesItsManifest proves the committed dist directory is the
// output of tools/pack-ui.mjs: every file listed in the manifest is present with
// the recorded hash and size, and nothing else is embedded.
func TestEmbeddedUIMatchesItsManifest(t *testing.T) {
	manifest, err := loadManifest(ui.Files)
	if err != nil || len(manifest.Files) == 0 {
		t.Fatalf("manifest: %v (%d files)", err, len(manifest.Files))
	}
	for name, entry := range manifest.Files {
		data, err := fs.ReadFile(ui.Files, "dist/"+name)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != entry.SHA256 || len(data) != entry.Bytes {
			t.Errorf("%s differs from the manifest; regenerate with `go generate ./internal/ui`", name)
		}
	}
	extra := 0
	_ = fs.WalkDir(ui.Files, "dist", func(path string, d fs.DirEntry, _ error) error {
		if !d.IsDir() && path != "dist/manifest.json" {
			if _, listed := manifest.Files[path[len("dist/"):]]; !listed {
				t.Errorf("%s is embedded but not in the manifest", path)
				extra++
			}
		}
		return nil
	})
}
