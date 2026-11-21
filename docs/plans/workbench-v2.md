# Workbench v2 implementation plan

The approved design is in `mocks/` (open `workbench.html`, with states listed in `mocks/README.md` and PNGs in `mocks/screens/`). The UI must match the mock structure, class names, tokens, spacing and copy patterns. When a mock and this plan disagree, the mock wins.

Standing rules from the owner:

- No layout shift. Loading states mirror the final layout. Fixed-width action buttons, reserved status slots and one-line assist rows.
- Accessible by construction: real buttons and inputs, ARIA comboboxes for lookups, a grid for the headers editor, focusable separators, `aria-describedby` errors, live-region announcements, 44 px targets on mobile, works at 130% text and 390 px width.
- Keyboard first: every action has a shortcut, shown on buttons, menus, the palette and the `?` sheet.
- Clean, readable, documented code. Small modules with one job. No dead code: delete the old implementation when its replacement lands.
- Server protocol changes are additive and optional so older adapters keep working. The UI shows a feature only when the data for it exists, and never fakes data.

## Track A: server (adapters/dotnet, spec, tests)

1. **Structured log capture.** An `ILoggerProvider` registered by `AddTestBench` that records log entries only inside a preview (or observed send) scope. Each entry adds optional fields to the protocol: `category`, `eventId` (`{ id, name }`), `offsetMs` (from request start), `properties` (structured-logging state as name/value strings, excluding `{OriginalFormat}`), `exception` (type and message only). Respect the host's configured minimum level. Cap entries (for example 500) and string sizes, and say so in the envelope (`logsTruncated: true`). The existing `TryRecordLog` keeps working.
2. **SQL capture (EF Core adapter).** A `DbCommandInterceptor` that records executed commands inside the scope as log entries with `level: "Sql"`, `category`, `elapsedMs`, `sql: { text, parameters: [{ name, value, dbType }], rowsAffected }`. Parameter values are redacted when the column or parameter name looks like a secret (password, secret, token, key, hash, salt). Honour `EnableSensitiveDataLogging`-style opt-out with a `TestBenchOptions` switch that defaults to showing values in Development only.
3. **Timing.** Emit a standard `Server-Timing` header on preview envelopes and observed sends: `auth`, `handler`, `db` (sum of interceptor time, with a `desc` holding the query count), `serialize`. The UI reads `Server-Timing` for both modes.
4. **Effects.** Document conventional `data` shapes the UI renders richly, keeping `kind`/`description` required: `email { from, to[], cc[], subject, text, html? }`, `http { method, url, status?, body? }`, `job { name, queue?, runAt?, arguments }`, `message { topic, key?, payload }`. Add typed helpers on `TestBenchPreview` (`TryRecordEmail`, `TryRecordHttp`, `TryRecordJob`, `TryRecordMessage`) that call `TryRecordEffect`. Update the TreasuryApi example to use them.
5. **Observed send.** Send must keep hitting the real operation URL. When the request carries `Prefer: trace` and the operation is advertised, run the same capture without rollback, return `X-TestBench-Trace: <id>` and keep the trace in a small in-memory cache (per user, 5 minutes, bounded count). `GET /bench/_api/traces/{id}` returns `{ changes, effects, logs, timing }` to the same user only. Effects on send are recorded as delivered (`delivered: true`) while the application still delivers them. Advertise with `"observedSend": true` in capabilities.
6. Update `spec/preview.schema.json`, `spec/capabilities.schema.json`, `spec/README.md`, package READMEs and tests (`tests/TestBench.AspNetCore.Tests`, `tests/TestBench.EntityFrameworkCore.Tests`, `examples/TreasuryApi/tests`). Security tests: traces are not readable by another user, capture never leaks outside the scope, redaction works, limits hold.

## Track B: UI (ui/, tools/, mocks/)

Phases are sequential. Each phase ends with unit tests, `node tools/browser-test.mjs`, `node tools/accessibility.mjs`, and screenshots of the real UI compared side by side with the matching mock PNG, fixing every visible difference.

1. **Foundation and shell.** Embed the approved stylesheet in `ui/styles.css` and delete the superseded styles. Port the mock icon sprite into `ui/icons.js`. Rebuild topbar, sidebar, resizable panes (focusable separators with the size tip), container queries and the mobile Request/Result switch to match mocks 01, 08 and 11. Keep the sign-in page working on the new tokens.
2. **Request builder.** Field anatomy (label row, control with status slot, one-line assist), validation with specific messages for every schema constraint, the issues popover from the action bar (no banner above the form), fixed-width Preview and Send, optional-field chips, list inputs, money, date and enum controls, the params tab. Mocks 01, 03, 04, 05, 11.
3. **IDs and autofill.** Lookup comboboxes over `x-lookup` and inferred list endpoints, the ID from the last response offered first, paste (⌘V) and random UUID (⌘I), the Autofill menu (⇧⌘F fill required, fill every field, reuse last request, new IDs, clear), generated `Idempotency-Key`. Mocks 03, 05.
4. **Headers editor.** ARIA grid with the three groups (required by the operation, set by Test Bench, custom), enable checkboxes, `{{uuid}}` variables, autocomplete from the spec and standard headers, per-row validation, presets, table and bulk edit, "From the spec" chips. Mocks 06, 07, 12.
5. **Keyboard and overlays.** One shortcut registry drives the `?` sheet, the ⌘K palette (scoped actions), `aria-keyshortcuts` and kbd hints. Mocks 09, 10.
6. **Result pane.** Response tab (follow-up requests derived from the OpenAPI document, the `Server-Timing` bar, JSON viewer with folding and line actions, schema-match pill), Database, Side effects cards, Logs (compact single-line rows, horizontal scroll, click or Enter to expand the breakdown), Headers (Location open, X-Request-ID match, request headers as sent, cookies). Preview and Sent states, running skeletons that mirror the final layout. Mocks 13–17 and 08. Uses the optional Track A fields when present.
7. **Finish.** Remove the superseded mocks and capture script, make the v2 design the reference in `mocks/`, and update the README screenshots, changelog and contributor guide.
