# Vendored libraries

The workbench ships with no bundler, so `ui/journeys/` imports these as plain ES modules instead
of npm packages. Each is one third-party library, bundled and minified by
[`tools/vendor-journeys-libs.mjs`](../../tools/vendor-journeys-libs.mjs); nothing here is
hand-written or modified. Re-run that script after bumping a version in `tools/package.json`.

| File | Package | Version | Licence | Size (minified / gzipped) |
| --- | --- | --- | --- | --- |
| `arazzo-runtime-expression.js` | [`@swaggerexpert/arazzo-runtime-expression`](https://github.com/swaggerexpert/arazzo-runtime-expression) | 3.4.0 | Apache-2.0 | 47.6 KB / 12.4 KB |
| `json-pointer.js` | [`@swaggerexpert/json-pointer`](https://github.com/swaggerexpert/json-pointer) | 3.0.2 | Apache-2.0 | 27.4 KB / 9.1 KB |
| `jsonpath-rfc9535.js` | [`jsonpath-rfc9535`](https://github.com/P0lip/jsonpath-rfc9535) | 1.3.0 | Apache-2.0 | 31.9 KB / 9.0 KB |

Together: about 107 KB minified, 30.5 KB gzipped (the three don't share a build, so this is the
plain sum; a real bundler that tree-shook and deduplicated them, as `tools/pack-ui.mjs` doesn't,
measured closer to 90.5 KB minified / 24.4 KB gzipped for all three combined).

`@redocly/respect-core`, the Node-side Arazzo runtime the CLI and MCP server (part E) use, is not
vendored here: it depends on `@redocly/openapi-core`, which reaches for `node:fs`, `node:path` and
`tty` and can't bundle for a browser. See [journeys-build.md, Contract 3](../../docs/plans/journeys-build.md#contract-3-the-engine-uijourneys)
for which library covers what.
