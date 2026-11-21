package sendproof

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"net/http"
	"strings"
	"time"

	"github.com/mprync/sendproof/adapters/go/internal/ui"
)

// assetManifest is the manifest.json emitted by tools/pack-ui.mjs.
type assetManifest struct {
	Version    string                `json:"version"`
	BundleHash string                `json:"bundleHash"`
	Files      map[string]assetEntry `json:"files"`
}

type assetEntry struct {
	SHA256      string `json:"sha256"`
	Bytes       int    `json:"bytes"`
	ContentType string `json:"contentType"`
}

// UIVersion returns the version and content hash of the embedded workbench UI.
func UIVersion() (version, bundleHash string) {
	manifest, err := loadManifest(ui.Files)
	if err != nil {
		return "", ""
	}
	return manifest.Version, manifest.BundleHash
}

func loadManifest(files fs.FS) (assetManifest, error) {
	var manifest assetManifest
	data, err := fs.ReadFile(files, "dist/manifest.json")
	if err != nil {
		return manifest, err
	}
	return manifest, json.Unmarshal(data, &manifest)
}

// uiManifest is parsed once. A binary built without the packed UI still compiles,
// and serves 404 for assets instead of failing at startup.
var uiManifest, _ = loadManifest(ui.Files)

// serveAsset writes one embedded UI asset with the types and hashes recorded in
// the manifest. Assets are revalidated on each load so a rebuilt API shows its new UI.
func serveAsset(w http.ResponseWriter, r *http.Request, name string) {
	entry, known := uiManifest.Files[name]
	if !known || strings.Contains(name, "..") {
		http.NotFound(w, r)
		return
	}
	data, err := fs.ReadFile(ui.Files, "dist/"+name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	headers := w.Header()
	headers.Set("Content-Type", entry.ContentType)
	headers.Set("Cache-Control", "no-cache")
	headers.Set("X-Content-Type-Options", "nosniff")
	headers.Set("ETag", `"`+entry.SHA256+`"`)
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
}
