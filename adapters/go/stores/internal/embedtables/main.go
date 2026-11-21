// Command embedtables copies the shared data-store classification tables from
// spec/data-stores/ into the stores package, where go:embed can reach them (an
// embed pattern cannot leave the module). Run it with `go generate ./stores`
// whenever the spec tables change. The parity test in the stores package fails
// when a copy differs from the spec.
package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// tables are the files copied from spec/data-stores/: batch one, then batch two.
var tables = []string{
	"redis.json", "mongodb.json", "dynamodb.json",
	"cassandra.json", "elasticsearch.json", "cosmosdb.json", "firestore.json",
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: embedtables <spec/data-stores dir> <destination dir>")
		os.Exit(2)
	}
	source, destination := os.Args[1], os.Args[2]
	for _, name := range tables {
		data, err := os.ReadFile(filepath.Join(source, name))
		if err != nil {
			fmt.Fprintln(os.Stderr, "embedtables:", err)
			os.Exit(1)
		}
		if err := os.WriteFile(filepath.Join(destination, name), data, 0o644); err != nil {
			fmt.Fprintln(os.Stderr, "embedtables:", err)
			os.Exit(1)
		}
	}
}
