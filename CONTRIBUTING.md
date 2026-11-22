# Contributing to Sendproof

Thanks for helping. Sendproof is one browser workbench and one HTTP protocol, implemented by a binding
for each of eight languages. Most changes touch one binding or the shared UI; the conformance suite
keeps them all behaving the same.

## Repository layout

| Path | What it holds |
| --- | --- |
| `ui/` | The shared workbench (plain ES modules and CSS, no build step) and its locales |
| `spec/` | The protocol: [adapter contract](spec/README.md), [data-store rules](spec/data-stores.md), JSON schemas and classification tables |
| `adapters/<language>/` | The bindings: `dotnet`, `node`, `python`, `java` (Java and Kotlin), `go`, `php`, `ruby`, `rust` |
| `tests/conformance/` | The shared HTTP conformance runner and its [manifest](tests/conformance/bindings.json) of 67 combinations |
| `tests/load/` | The load harness behind [docs/performance.md](docs/performance.md) |
| `examples/` | The store example app and the conformance fixtures |
| `mocks/` | The approved design mocks the UI is compared against |
| `tools/` | Packaging, release, browser and screenshot tooling |

## Set up

Install the toolchain of the binding you are changing (each binding's README lists the tested
versions), plus Node.js 22.14 or newer for the conformance runner and the UI tests. Database and store
services come from one digest-pinned Compose file:

```sh
docker compose -f tests/conformance/compose.yml up -d --wait postgres mysql mariadb mongodb redis dynamodb
```

## Check a change

Run the binding's own suite, then the shared conformance checks for the combinations you touched.

| Binding | Prepare and test |
| --- | --- |
| .NET | `dotnet build Sendproof.slnx` then `dotnet test Sendproof.slnx --no-build` |
| Node.js | `npm ci --prefix adapters/node && npm run build:fixtures --prefix adapters/node && npm test --prefix adapters/node` |
| Python | `python3 adapters/python/scripts/prepare.py` then `adapters/python/.venv/bin/python -m pytest adapters/python -q` |
| Java and Kotlin | `sh adapters/java/scripts/gradle.sh test` |
| Go | `adapters/go/scripts/setup-go.sh` then `cd adapters/go && scripts/go.sh test ./...` ([details](adapters/go/README.md#building-and-testing)) |
| PHP | `sh adapters/php/scripts/prepare.sh` then `sh adapters/php/scripts/test.sh` |
| Ruby | `adapters/ruby/bin/prepare` then `adapters/ruby/bin/test` |
| Rust | `adapters/rust/scripts/pack-assets.sh` then `cargo test --locked --manifest-path adapters/rust/Cargo.toml --workspace --all-features` |

```sh
npm ci --prefix tests/conformance
node tests/conformance/run.mjs --list                  # every combination and its prepare command
node tests/conformance/run.mjs node-express go-gin     # run selected combinations
node tests/conformance/run.mjs --database postgresql   # every combination on one database
```

The runner starts each fixture on loopback, sends real HTTP requests and checks the database through a
separate connection. The [binding guide](docs/bindings/README.md#run-the-same-checks-locally) and
[database guide](docs/bindings/databases.md#run-database-conformance) explain the options.

For UI changes, also run the browser checks:

```sh
node --test tests/ui/*.test.mjs ui/*.test.mjs
npm ci --prefix tools
npx --prefix tools playwright install chromium
node tools/browser-test.mjs
node tools/accessibility.mjs
```

The browser test creates and removes an isolated sample database by default. Pointing `SENDPROOF_URL`
at a running example app commits test data there. Browser evidence is saved under `artifacts/browser/`.

CI runs every binding's suite, the full conformance matrix, the browser checks on Linux, Windows and
macOS, and packaging for every registry. Its run summary lists each result.

## Build every package

`node tools/pack-all.mjs` builds every binding into the archive its registry publishes, under
`artifacts/packages/<registry>/` with a `SHA256SUMS` file: NuGet packages and symbols, npm tarballs,
Python wheels and sdists, a Maven repository layout, `.crate` files, gems, Composer ZIPs and Go module
ZIPs. Registries whose toolchain is not installed are skipped and listed in the summary.

```sh
node tools/pack-all.mjs --verify            # build, then install each archive into a fresh consumer app
node tools/pack-all.mjs --verify --only npm,pypi
```

`--verify` creates a throwaway project outside the repository for each registry, installs the built
archives (never the source tree) and starts a minimal application that must serve the workbench at
`/sendproof/` and its OpenAPI document. The version comes from `Directory.Build.props` and the repository
URL from `adapters/go/MODULE_PATH`. See the [publishing guide](docs/publishing.md) for releases.

## Choose the extension point

| Change | Start here | What to verify |
| --- | --- | --- |
| A new framework or language | The [protocol](spec/README.md) and the [binding checklist](docs/bindings/adding.md) | The shared conformance suite passes for the new entry in `tests/conformance/bindings.json`. |
| A new SQL provider or ORM | The binding's provider interface (for example `IPreviewProvider` in .NET, `previewProvider` in Node, `sendproof.Provider` in Go) | The handler uses the enlisted connection, transaction-control statements are refused, rollback completes before the result is returned, and errors leave storage consistent. |
| A new data store | [spec/data-stores.md](spec/data-stores.md) and its classification tables | Reads run, writes are refused before they are sent, and the shared data-store checks pass. |
| A field or schema convention | `ui/schema.js`, or a host field module (`WithFieldModule`, `fieldModules`, …) | Use a second, unrelated OpenAPI example. Keep Form and JSON edits interchangeable. |
| A request export | `ui/snippets.js` | Preserve method, URL, headers, body and preview intent. Cover escaping and credential masking. |
| A sign-in method | The application's auth handlers and the workbench provider descriptor | A real sign-in and a permission denial with the same session. |
| A translation | `ui/locales/` and its [README](ui/locales/README.md) | `node --test tests/ui/locales.test.mjs` |

Keep framework dependencies inside their own packages. Document public APIs and any assumptions a host
must satisfy, particularly transaction ownership and side effects. Include a regression test when a
change can affect persisted data or authorization: a Preview that leaves a write behind is the worst
bug this project can have.

## Work with the visual reference

The [approved mock states](mocks/README.md) define the interface. Reuse the markup, styles, states and
breakpoints, and compare the live feature with the matching desktop and mobile mock, including keyboard
navigation, large text and dark mode. When a feature needs a new design surface, propose a mock first.
Use `node tools/shoot-mocks.mjs` only when intentionally refreshing the reference images, and
`node tools/readme-shots.mjs` to regenerate the README images from the running example app.

## Pull requests

Explain the user-visible change, list the checks you ran, and include before and after images for
visual changes. Keep pull requests focused; a binding change and an unrelated UI change are easier to
review apart. For a security issue, don't open a pull request or issue: follow [SECURITY.md](SECURITY.md).
