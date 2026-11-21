// Command fixture runs the Sendproof conformance fixture for one framework.
//
//	fixture [nethttp|chi|gin|echo] [sql|gorm]
//
// It reads PORT, BENCH_PATH_BASE and BENCH_SCENARIO from the environment, and
// selects its database with BENCH_DATABASE (sqlite, postgresql, mysql or
// sqlserver) and BENCH_DATABASE_URL, a fresh empty database for server engines.
// The SQLite file goes to BENCH_TMP_DIR when it is set.
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mprync/sendproof/adapters/go/examples/fixture"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "fixture:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg := fixture.Config{
		Framework: arg(1, "nethttp"), Store: arg(2, "sql"),
		Scenario: env("BENCH_SCENARIO", "standard"), PathBase: os.Getenv("BENCH_PATH_BASE"),
		Database: fixture.Database{
			Engine: env("BENCH_DATABASE", "sqlite"), URL: os.Getenv("BENCH_DATABASE_URL"), Directory: os.Getenv("BENCH_TMP_DIR"),
		},
	}
	handler, cleanup, err := fixture.New(cfg)
	if err != nil {
		return err
	}
	defer cleanup()

	listener, err := net.Listen("tcp", "127.0.0.1:"+env("PORT", "8080"))
	if err != nil {
		return err
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	stop, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		<-stop.Done()
		shutdown, release := context.WithTimeout(context.Background(), 2*time.Second)
		defer release()
		_ = server.Shutdown(shutdown)
	}()
	fmt.Printf("fixture %s/%s on %s listening on %s (scenario %s, base %q)\n", cfg.Framework, cfg.Store, cfg.Database.Engine, listener.Addr(), cfg.Scenario, cfg.PathBase)
	if err := server.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func arg(index int, fallback string) string {
	if len(os.Args) > index {
		return os.Args[index]
	}
	return fallback
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
