// Command modzip builds the zip file the Go module proxy would serve for a
// module directory, so a release can be inspected before it is tagged.
//
//	modzip -dir adapters/go -path github.com/org/repo/adapters/go -version v0.1.0 -out out.zip
//
// It lists the embedded UI files it found and fails when a required file is
// missing, which proves a consumer's `go get` receives the packed workbench.
package main

import (
	"archive/zip"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/mod/module"
	modzip "golang.org/x/mod/zip"
)

func main() {
	dir := flag.String("dir", "", "module directory")
	path := flag.String("path", "", "module path")
	version := flag.String("version", "", "semantic version such as v0.1.0")
	out := flag.String("out", "", "zip file to write")
	require := flag.String("require", "", "comma-separated zip entries that must exist, relative to the module root")
	forbid := flag.String("forbid", "", "comma-separated zip entries that must not exist, relative to the module root")
	exclude := flag.String("exclude", "", "comma-separated files, relative to the module root, left out of the zip (for example go.work)")
	flag.Parse()
	if err := run(*dir, *path, *version, *out, *require, *forbid, *exclude); err != nil {
		fmt.Fprintln(os.Stderr, "modzip:", err)
		os.Exit(1)
	}
}

// dirFile is a file of the module directory, addressed by its slash path.
type dirFile struct{ filepath, slash string }

func (f dirFile) Path() string                 { return f.slash }
func (f dirFile) Lstat() (os.FileInfo, error)  { return os.Lstat(f.filepath) }
func (f dirFile) Open() (io.ReadCloser, error) { return os.Open(f.filepath) }

func run(dir, path, version, out, require, forbid, exclude string) error {
	// Check the directory exactly as the module proxy would, then drop the
	// excluded files. Nested modules, VCS metadata and symlinks are already
	// left out by CheckDir.
	// CheckDir expects a clean path ("adapters/go/." would make every file "not relative").
	dir = filepath.Clean(dir)
	checked, err := modzip.CheckDir(dir)
	if err != nil {
		return err
	}
	if err := checked.Err(); err != nil {
		return err
	}
	skipped := map[string]bool{}
	for _, name := range strings.Split(exclude, ",") {
		if name != "" {
			skipped[name] = true
		}
	}
	var files []modzip.File
	for _, name := range checked.Valid {
		// CheckDir reports OS paths inside dir; the zip wants slash paths relative to it.
		relative, err := filepath.Rel(dir, name)
		if err != nil {
			return err
		}
		if slash := filepath.ToSlash(relative); !skipped[slash] {
			files = append(files, dirFile{filepath: name, slash: slash})
		}
	}
	file, err := os.Create(out)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := modzip.Create(file, module.Version{Path: path, Version: version}, files); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	reader, err := zip.OpenReader(out)
	if err != nil {
		return err
	}
	defer reader.Close()
	prefix := path + "@" + version + "/"
	entries := map[string]bool{}
	ui := 0
	for _, entry := range reader.File {
		name := strings.TrimPrefix(entry.Name, prefix)
		entries[name] = true
		if strings.HasPrefix(name, "internal/ui/dist/") {
			ui++
		}
	}
	for _, name := range strings.Split(require, ",") {
		if name != "" && !entries[name] {
			return fmt.Errorf("%s is missing from the module zip", name)
		}
	}
	for _, name := range strings.Split(forbid, ",") {
		if name != "" && entries[name] {
			return fmt.Errorf("%s must not be in the module zip", name)
		}
	}
	fmt.Printf("%s: %d files, %d embedded UI files\n", out, len(reader.File), ui)
	return nil
}
