# @sendproof/core

Protocol and capture shared by the Node framework adapters, and the `sendproof` command line (the [journeys runner](#journeys) and the [MCP server](#connect-an-agent)). Install the framework package for your application. It depends on this package and serves the bundled assets.

Use `deliverEffect` where the application sends an email, enqueues work or makes a similar external call. It records the effect and suppresses delivery during Preview. During ordinary Send it invokes the supplied callback and, when the request is observed, records successful delivery.

```js
import { currentCapture, deliverEffect } from '@sendproof/core';

currentCapture()?.log({ level: 'Information', category: 'Items', message: 'Created an item' });
await deliverEffect({ kind: 'email', description: 'Item created', data: { subject: 'Item created' } },
  () => mailer.send(message));
```

Logs and database snapshots are request-scoped. Secret names are judged by whole words (`password`, `passwd`, `pwd`, `secret`, `token`, `hash`, `salt`, `credential(s)`, `apikey`, and `key` after `api`, `private`, `secret`, `access`, `signing`, `encryption` or `client`): such SQL parameters, every parameter of a statement whose text names a secret, and secret-named columns and keys in change snapshots are recorded as `[REDACTED]`. `database` must be a display name such as `PostgreSQL`; connection strings, URLs, host:port and paths are rejected. A trace belongs to the identity's `subject`, `scheme` and optional `issuer` within the path base, and its id carries 128 random bits. `endsTransaction`, `mayWrite` and `splitStatements` are the statement classifier the database providers share. See [the TypeScript types](src/types.ts) for option and provider contracts. The provider's `preview(dispatch)` must forward the handler's result only after the enrolled transaction has rolled back, and reject if rollback fails.

`npm pack` runs the shared asset packer and includes the generated assets and manifest. Use `npm run build --prefix adapters/node` when working from a checkout.

## The sendproof command

`sendproof mcp` is an [MCP](https://modelcontextprotocol.io) server that gives an AI agent what the Sendproof workbench gives a person: the API's operations and models, real values for lookup fields, **Preview** (the real handler runs and rolls back, with every write, effect and log returned), **Send**, and running **journeys**, as the signed-in user or a development persona. `sendproof journeys` runs the same journeys from a terminal or CI.

It talks to the `/sendproof` endpoints every Sendproof adapter serves, so it works the same for .NET, Node, Python, Java, Kotlin, Go, PHP, Ruby and Rust APIs. The MCP server needs `@modelcontextprotocol/sdk`, an optional peer of this package, so adapters don't install it; `journeys` doesn't need it.

### Connect an agent

Start your API with its Sendproof adapter, then add the server to your MCP client.

Claude Code:

```sh
claude mcp add store-api -- npx -y -p @sendproof/core -p @modelcontextprotocol/sdk@1 sendproof mcp --api http://127.0.0.1:5189 --persona ada.admin@acme.dev
```

Claude Desktop, Cursor and other clients take the same command in their configuration:

```json
{
  "mcpServers": {
    "store-api": {
      "command": "npx",
      "args": ["-y", "-p", "@sendproof/core", "-p", "@modelcontextprotocol/sdk@1",
               "sendproof", "mcp", "--api", "http://127.0.0.1:5189", "--persona", "ada.admin@acme.dev"]
    }
  }
}
```

### Journeys

`sendproof journeys list` and `sendproof journeys run` run the API's published journeys (Arazzo workflows with expected writes) exactly as the workbench and the MCP run tools do: the same engine (`ui/journeys/`, copied into this package at build) binds every step, checks its success criteria and compares its writes.

```sh
npx -y @sendproof/core journeys list --api http://127.0.0.1:5189
npx -y @sendproof/core journeys run orderToShipment --api http://127.0.0.1:5189 --inputs inputs.json --out run.json --junit report.xml
npx -y @sendproof/core journeys run --all --api http://127.0.0.1:5189                      # every journey, in Preview
npx -y @sendproof/core journeys run priceWithCoupon --api http://127.0.0.1:5189 --mode send --yes --allow-send   # Send-only journeys need Send
```

In a project that already depends on a Sendproof adapter, `npx sendproof journeys run …` uses the installed copy.

A **Preview** run opens one Preview session the whole run shares, so step 3 sees what step 1 wrote and nothing is ever committed (needs `previewSessions: true` in the API's capabilities); a **Send** run sends every step for real with a trace, needs `--yes` plus `--allow-send` (Development) or `--allow-send-anywhere`, and is the only way to run a journey the API marks Send only (one that writes to a store, such as Redis, that can't roll back). `--inputs` is a JSON file of the journey's inputs; a journey's own input defaults fill in anything not given. Exit code 0 means every named journey passed, 1 means one failed, 2 means one couldn't run at all (an unknown journey, a session the adapter refused). `--out` writes the run (or an array of runs) as JSON; `--junit` writes one `<testsuite>` per journey.

The same run tools are in the MCP server, only when the API publishes journeys and either supports Preview sessions or allows Send:

| Tool | Does |
| --- | --- |
| `start_run` | Starts a run of one journey in `preview` or `send`; opens the Preview session, or needs `confirmSend: true` for Send. Signs in as the journey's own persona first, when it names one |
| `run_step` | Runs the next pending step, or a named one; `overrides` replaces individual bound values first. Returns its response, criteria, outputs and write-comparison findings |
| `run_remaining` | Runs every pending step until the run itself stops, and returns it |
| `get_run` | The whole run as recorded so far |
| `end_run` | Ends a run and rolls back its Preview session (idempotent) |
| `draft_approved_difference` | Drafts one approved-difference record per differing field of a finding (or one for a whole missing/extra write): code for a journey defined in code, the JSON record for one from a file. Never writes a file |

Every open run's Preview session is rolled back and ended when the MCP server shuts down.

### Options

| Option | Does |
| --- | --- |
| `--api <url>` | The API's base URL, including any path base (`https://host/tenant`). Required |
| `--mount <path>` | Where Sendproof is mounted under it. Default `/sendproof` |
| `--persona <email>` | Switch to a development persona at start (the API's `personas` sign-in source) |
| `--sign-in <email>` | Sign in through the API's password provider; the password comes from `SENDPROOF_PASSWORD` |
| `--header "Name: value"` | Send a header on every request, such as `Authorization: Bearer …`. Repeatable |
| `--cookie name=value` | Start with a session cookie. Repeatable |
| `--allow-send` | Let `send_request` commit `POST`, `PUT`, `PATCH` and `DELETE` when the API reports `Development` |
| `--allow-send-anywhere` | Let `send_request` commit in any environment |
| `--timeout <ms>` | Abandon a request after this long. Default 30000 |

`journeys run` also takes: `--all` (every journey, instead of naming them), `--mode preview\|send` (default `preview`), `--yes` (confirms a Send run), `--inputs <file>`, `--out <file>` and `--junit <file>`.

### MCP tools

| Tool | Does |
| --- | --- |
| `get_api` | The API's name, environment, database and data stores, who is signed in, how to sign in, how many operations can be previewed, and whether Send can be traced |
| `list_operations` | Operations with their method, path, summary, tag, sign-in need, deprecation, and whether Preview is available (and why not). Filter by words, tag or Preview |
| `describe_operation` | Parameters, request body, responses, security and Preview availability. Named models appear as `{ "$ref": "Name" }` |
| `list_models`, `describe_model` | The named schemas, and one schema with the operations that use it |
| `find_values` | Real values for a field: the records a lookup (`x-lookup`) returns for the signed-in user, or an enum's values. Fields are parameter names or body paths such as `items[].sku` |
| `preview_request` | Runs the real handler and rolls it back. Returns the response, the rows and documents it changed (before and after), the effects it would have had, its logs and SQL, and `Server-Timing`. A write to a store that can't roll back stops the Preview and says which store and command |
| `send_request` | Sends for real. Reads (`GET`, `HEAD`, `OPTIONS`) are always allowed; other methods need `--allow-send` and `confirmSend: true`. Traced when the API supports it, so the result shows what was committed |
| `get_trace` | The writes, effects, logs and timing an observed Send recorded |
| `list_personas`, `switch_persona` | The API's development accounts, and signing the session in as one. Listed only when the API offers personas |
| `list_journeys`, `describe_journey` | Journeys the API publishes (Arazzo workflows with their expected writes and approved differences). Listed only when the API publishes journeys |
| `start_run`, `run_step`, `run_remaining`, `get_run`, `end_run`, `draft_approved_difference` | Runs a journey and reports its results (see Journeys above). Listed only when the API publishes journeys and either supports Preview sessions or allows Send |

Every tool has an input and an output schema and returns structured content with a one-line summary. A problem the agent can fix (a missing path parameter, a refused Send, an unknown operation with the likely one it meant) comes back as a tool error with that message. The server also lists two resources: `sendproof://capabilities` and the full OpenAPI document as `sendproof://openapi/{name}`.

### Safety

- **Preview never writes.** A result counts only when the adapter's envelope confirms the rollback; anything else is an error that says the effect is unknown. A Preview journey run is the same, held in one Preview session that's rolled back on `end_run`, on process exit, or by the adapter's own idle and lifetime limits.
- **Send is off for writes by default.** With `--allow-send` it works only where the API reports `Development`, and each call still needs `confirmSend: true`.
- **One origin.** Every request goes to the `--api` origin, under its path base. Redirects are never followed, nothing is retried, and cookies the API sets stay in memory for the session.
- **The agent acts as you.** Requests carry the session you give it (`--persona`, `--sign-in`, `--header`, `--cookie`), so the API's own authorization applies to everything the agent does.
- **stdout is the protocol.** The server writes its one status line and any errors to stderr.

### Programmatic use

```ts
import { createServer } from '@sendproof/core/cli';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const { server } = createServer({ api: 'http://127.0.0.1:5189', allowSend: 'development' });
await server.connect(new StdioServerTransport());
```
