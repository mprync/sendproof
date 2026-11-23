package sendproof

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"regexp"
	"strings"
)

const journeyPath = workbenchPrefix + "/journeys/"

var journeyName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)

type journeyDocument struct {
	name, stem   string
	source       string
	arazzo       json.RawMessage
	expectations json.RawMessage
}

// WithJourneys registers a JSON Arazzo document and its sibling .expect.json
// file, read at startup. The filesystem can be an embed.FS or os.DirFS.
// Author root-relative OpenAPI URLs relative to the application mount.
func WithJourneys(files fs.FS, arazzoFile string) Option {
	return func(c *config) error {
		stem, ok := strings.CutSuffix(path.Base(arazzoFile), ".arazzo.json")
		if files == nil || !ok || !journeyName.MatchString(stem) {
			return errors.New("sendproof: WithJourneys needs a filesystem and a file named <name>.arazzo.json")
		}
		for _, doc := range c.journeys {
			if doc.stem == stem {
				return fmt.Errorf("sendproof: journey file name %q is already registered", stem)
			}
		}
		arazzo, err := fs.ReadFile(files, arazzoFile)
		if err != nil {
			return fmt.Errorf("sendproof: read journey: %w", err)
		}
		var info struct {
			Info struct{ Title string }
		}
		if err := json.Unmarshal(arazzo, &info); err != nil || strings.TrimSpace(info.Info.Title) == "" {
			return fmt.Errorf("sendproof: %s needs a JSON Arazzo document with an info title", arazzoFile)
		}
		expectationsName := stem + ".expect.json"
		expectations, err := fs.ReadFile(files, path.Join(path.Dir(arazzoFile), expectationsName))
		if err != nil {
			return fmt.Errorf("sendproof: read journey expectations: %w", err)
		}
		var rules struct {
			Version  string `json:"sendproofExpectations"`
			Arazzo   string
			Journeys map[string]json.RawMessage
		}
		if err := json.Unmarshal(expectations, &rules); err != nil ||
			rules.Version != "1.0" || rules.Arazzo != path.Base(arazzoFile) || rules.Journeys == nil {
			return fmt.Errorf("sendproof: %s needs a matching Sendproof expectations document", expectationsName)
		}
		c.journeys = append(c.journeys, journeyDocument{info.Info.Title, stem, "file", arazzo, expectations})
		return nil
	}
}

func (b *Sendproof) journeyDiscovery(base string) []map[string]string {
	result := make([]map[string]string, 0, len(b.cfg.journeys))
	for _, doc := range b.cfg.journeys {
		url := base + journeyPath + doc.stem
		result = append(result, map[string]string{
			"name": doc.name, "source": doc.source, "arazzoUrl": url + ".arazzo.json", "expectationsUrl": url + ".expect.json",
		})
	}
	return result
}

func (b *Sendproof) serveJourney(w http.ResponseWriter, r *http.Request) bool {
	file, ok := strings.CutPrefix(r.URL.EscapedPath(), journeyPath)
	if !ok || !strings.HasSuffix(file, ".arazzo.json") && !strings.HasSuffix(file, ".expect.json") {
		return false
	}
	w.Header().Set("Cache-Control", "no-store")
	for _, doc := range b.cfg.journeys {
		switch file {
		case doc.stem + ".expect.json":
			writeJSON(w, http.StatusOK, doc.expectations)
			return true
		case doc.stem + ".arazzo.json":
			arazzo, err := mountJourney(doc.arazzo, b.pathBase(r))
			if err != nil {
				reject(w, http.StatusInternalServerError, "The journey document could not be served.")
			} else {
				writeJSON(w, http.StatusOK, arazzo)
			}
			return true
		}
	}
	http.NotFound(w, r)
	return true
}

func mountJourney(arazzo json.RawMessage, base string) (json.RawMessage, error) {
	if base == "" {
		return arazzo, nil
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(arazzo, &doc); err != nil {
		return nil, err
	}
	var sources []map[string]json.RawMessage
	if err := json.Unmarshal(doc["sourceDescriptions"], &sources); err != nil {
		return nil, err
	}
	for _, source := range sources {
		var url string
		if json.Unmarshal(source["url"], &url) == nil && strings.HasPrefix(url, "/") && !strings.HasPrefix(url, "//") {
			source["url"], _ = json.Marshal(base + url)
		}
	}
	doc["sourceDescriptions"], _ = json.Marshal(sources)
	return json.Marshal(doc)
}
