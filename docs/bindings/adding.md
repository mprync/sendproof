# Adding a binding

## Start with one framework

- [ ] Read [protocol v1](../../spec/README.md) and its JSON schemas. Reuse the framework's OpenAPI route.
- [ ] Create a framework-neutral core with discovery, capture, SQL redaction, an owner-bound trace store, and an environment gate.
- [ ] Add a framework package with the normal application registration API. Route Preview through the real handler, binding and authorization with the original method, query, headers and body. Verify the matched operation explicitly allows Preview.
- [ ] Keep transactions and change capture in a data package. Enroll every write on the connection or session used by the handler and only acknowledge Preview after successful rollback and cleanup. Document capture coverage for raw SQL, tracked models, triggers and bulk statements.
- [ ] Publish one copy of the shared UI with the framework or core package. Run `node tools/pack-ui.mjs --out <generated-package-directory> --version <package-version>` during the build. Include its manifest in the artifact and serve only its listed files. Preserve relative URLs in the HTML. The .NET embedding uses its existing project resources.
- [ ] Use [the reference fixture contract](../../spec/conformance/fixture.md) to make a disposable app and seed access controls. Add package READMEs and a runnable example.
- [ ] Add the fixture to the manifest, run local tests and run shared HTTP conformance. Verify the contents of the language package before enabling publishing. Update the option mapping and changelog.

## Scaffold

```text
adapters/<language>/
  core/             Protocol types, capture, traces and embedded UI
  <framework>/      Middleware, routing and response transport
  <data-layer>/     Transaction provider and change capture
  examples/         Minimal application and fixture
```

Add this manifest entry under `bindings` with a unique ID and loopback port. Use root-relative paths for fixture commands. The `prepare` and `test` fields are shell commands for CI.

```json
{
  "id": "language-framework",
  "toolchain": "language",
  "database": "sqlite",
  "port": 5401,
  "readiness": "/ready",
  "prepare": "sh adapters/language/scripts/prepare.sh",
  "test": "sh adapters/language/scripts/test.sh",
  "start": ["sh", "adapters/language/scripts/fixture.sh"],
  "traceTtlMs": 5000
}
```

The runner sets `PORT`, `BENCH_SCENARIO`, `BENCH_PATH_BASE`, `BENCH_TMP_DIR` and `BENCH_DATABASE` for each fresh fixture. A fixture can use its temporary directory for keys and database files. PostgreSQL, MySQL and SQL Server entries also receive an isolated `BENCH_DATABASE_URL`. CI expands the manifest into jobs and starts the matching database service. Add a toolchain setup step under `conformance` if the runtime is new.
