// Package redisbench guards go-redis v9 clients for Sendproof Preview
// (spec/data-stores.md, store mode "guard").
//
// Add the hook to every client the application's handlers use, and register the
// store so discovery lists it:
//
//	rdb := redis.NewClient(&redis.Options{Addr: addr})
//	rdb.AddHook(redisbench.Hook())
//	bench, _ := sendproof.New(sendproof.WithDataStore(redisbench.Store("cache")))
//
// Reads run normally. During a Preview the first write is refused before any
// byte of it is sent, with a *sendproof.PreviewWriteBlockedError, and the Preview
// answers HTTP 409 whatever the handler does with the error. Pipelines and
// MULTI/EXEC transactions are classified as a whole before the first command is
// written. Session commands (AUTH, HELLO, SELECT, PING and the like) are never
// guarded or logged, so the password never reaches a capture. Every other command
// becomes a Db log entry whose statement keeps the command name and key arguments
// only (SET session:42 ?).
//
// # Coverage
//
// Only hooked clients are covered, and only calls made with the request's
// context: pass r.Context() (or a context derived from it) to every command. A
// client created inside a handler, a second client for the same server, a call
// with context.Background() and Pub/Sub connections (which bypass go-redis hooks)
// are not guarded. Sidekiq-style job enqueues are writes and block a Preview;
// record such jobs as effects with sendproof.RecordJob instead. rueidis is not
// supported.
package redisbench

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/mprync/sendproof/adapters/go/sendproof"
	"github.com/mprync/sendproof/adapters/go/stores"
	"github.com/redis/go-redis/v9"
)

// system is the store id of Redis in discovery, change records and Db entries.
const system = "redis"

// Option configures Hook.
type Option func(*settings) error

type settings struct {
	reads map[string]bool
}

// TreatAsRead declares commands the host states never write, such as a custom
// module read MYMODULE.GET, by exact name (CONTAINER|SUB for a subcommand), with
// no wildcards. It is the host's statement that the command never writes: a
// wrongly listed write is not blocked in a Preview.
func TreatAsRead(names ...string) Option {
	return func(s *settings) error {
		reads, err := stores.ReadSet(names, strings.ToUpper)
		if err != nil {
			return err
		}
		if s.reads == nil {
			s.reads = map[string]bool{}
		}
		for name := range reads {
			s.reads[name] = true
		}
		return nil
	}
}

// Hook returns the go-redis hook that guards and logs the client's commands. Pass
// it to Client.AddHook (or ClusterClient.AddHook, Ring.AddHook). It panics when
// an option is invalid, because that is a startup configuration error.
func Hook(options ...Option) redis.Hook {
	var config settings
	for _, option := range options {
		if err := option(&config); err != nil {
			panic(err)
		}
	}
	return &hook{reads: config.reads}
}

// Store returns the data store for sendproof.WithDataStore. name is an optional
// display label for discovery, such as "cache": never a URL or host name. It
// panics on a label that looks like connection details.
func Store(name string) sendproof.DataStore {
	label, err := stores.Label(name)
	if err != nil {
		panic(err)
	}
	return &store{name: label}
}

// store is the discovery entry of a hooked Redis client. Redis has no Preview
// transaction, so it prepares nothing per Preview.
type store struct{ name string }

func (s *store) Describe(context.Context) sendproof.DataStoreInfo {
	return sendproof.DataStoreInfo{System: system, Name: s.name, Mode: sendproof.ModeGuard}
}

func (s *store) BeginPreview(context.Context) (sendproof.StorePreview, error) { return nil, nil }

// hook implements redis.Hook.
type hook struct{ reads map[string]bool }

func (h *hook) DialHook(next redis.DialHook) redis.DialHook {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		return next(ctx, network, addr)
	}
}

// command is one classified command.
type command struct {
	name string
	args []string
	kind stores.Kind
}

// describe classifies a command. Arguments are rendered as text for the
// classifier and the statement only; they are never stored.
func (h *hook) describe(cmd redis.Cmder) command {
	args := cmd.Args()
	text := make([]string, 0, len(args))
	for _, arg := range args {
		switch typed := arg.(type) {
		case string:
			text = append(text, typed)
		case []byte:
			text = append(text, string(typed))
		default:
			text = append(text, fmt.Sprint(typed))
		}
	}
	name := cmd.Name()
	if len(text) > 0 {
		name, text = text[0], text[1:]
	}
	kind := stores.ClassifyRedis(name, text, h.reads)
	if kind == stores.Write && strings.EqualFold(name, "CLIENT") && len(text) > 0 && strings.EqualFold(text[0], "MAINT_NOTIFICATIONS") {
		// go-redis 9.23 sends this on every new connection to subscribe to server
		// maintenance push notifications. It is connection-level like CLIENT SETINFO,
		// but the shared table predates it, so it would otherwise block every Preview.
		kind = stores.Session
	}
	return command{name: strings.ToUpper(name), args: text, kind: kind}
}

// refuse asks the guard about one command and, for a write, returns its error.
func refuse(ctx context.Context, c command) error {
	return sendproof.Guard(ctx, system, c.name, c.kind == stores.Write, "")
}

func (h *hook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		c := h.describe(cmd)
		if err := refuse(ctx, c); err != nil {
			cmd.SetErr(err)
			return err
		}
		started := time.Now()
		err := next(ctx, cmd)
		record(ctx, c, started, err)
		return err
	}
}

func (h *hook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []redis.Cmder) error {
		// Classify the whole batch before the first command is written: refusing one
		// command mid-pipeline would corrupt reply matching. MULTI queues commands
		// that run only at EXEC, so a refused write inside one means EXEC never runs.
		described := make([]command, len(cmds))
		for index, cmd := range cmds {
			described[index] = h.describe(cmd)
			if err := refuse(ctx, described[index]); err != nil {
				for _, other := range cmds {
					other.SetErr(err)
				}
				return err
			}
		}
		started := time.Now()
		err := next(ctx, cmds)
		for index, cmd := range cmds {
			failure := cmd.Err()
			if errors.Is(failure, redis.Nil) {
				failure = nil
			}
			record(ctx, described[index], started, failure)
		}
		return err
	}
}

// record logs a command as a Db entry. Session and transaction commands are never
// logged.
func record(ctx context.Context, c command, started time.Time, failure error) {
	if c.kind == stores.Session || c.kind == stores.Transaction {
		return
	}
	statement, target := stores.RedisStatement(c.name, c.args)
	call := sendproof.DbCall{
		System: system, Operation: c.name, Target: target, Statement: statement,
		RowsAffected: sendproof.UnknownRows, Duration: time.Since(started),
	}
	if failure != nil {
		call.Error = errorName(failure)
	}
	sendproof.RecordDb(ctx, call)
}

// errorName is the error code of a Redis error reply (WRONGTYPE, OOM), or "Error".
func errorName(err error) string {
	var reply redis.Error
	if errors.As(err, &reply) {
		if code, _, found := strings.Cut(reply.Error(), " "); found && code == strings.ToUpper(code) {
			return code
		}
	}
	return "Error"
}
