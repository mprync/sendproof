// Package ui embeds the packed Test Bench workbench.
//
// The dist directory is generated from the repository's ui/ sources by
// tools/pack-ui.mjs. Regenerate it with `go generate ./internal/ui` after the UI
// changes, and commit the result: the Go module must carry the assets so that
// `go get` needs neither Node nor the rest of the repository.
package ui

import "embed"

//go:generate sh -c "rm -rf dist && node ../../../../tools/pack-ui.mjs --out dist"

// Files holds the packed workbench under dist/, with its manifest.json.
//
//go:embed all:dist
var Files embed.FS
