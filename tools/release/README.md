# Release packaging modules

`node tools/pack-all.mjs` builds every binding into the archive format its registry accepts. It loads one
module per registry from this directory, in this order:

| Module | Registry | Output in `artifacts/packages/<id>/` |
| --- | --- | --- |
| `nuget.mjs` | nuget.org | ten `.nupkg` + `.snupkg` pairs |
| `npm.mjs` | npmjs.com | seventeen `npm pack` tarballs |
| `pypi.mjs` | PyPI | a wheel and an sdist per package |
| `maven.mjs` | Maven Central | a Maven repository layout: jars, sources, javadoc, POMs, Gradle module files |
| `crates.mjs` | crates.io | `cargo package` `.crate` files |
| `rubygems.mjs` | RubyGems.org | `.gem` files |
| `packagist.mjs` | Packagist | one ZIP per package, holding exactly the tree pushed to its split repository |
| `go.mjs` | Go module proxy | module ZIPs and `tags.txt`; Go itself is released by pushing the tags |

## Where each registry lists its packages

Packages are listed by hand, in dependency order, in the places below. The CI publish jobs and the
`platforms` matrix name no package: they publish whatever `pack-all` wrote to `artifacts/packages/<id>/`.

| Registry | Packages | Listed in | Consumer smoke test |
| --- | --- | --- | --- |
| npm | 10 framework packages plus `@sendproof/redis`, `/dynamodb`, `/mongodb`, `/cassandra`, `/elasticsearch`, `/cosmosdb`, `/firestore` | `PACKAGES` in `npm.mjs` | `verify` type-checks and loads every entry point |
| NuGet | `Sendproof.AspNetCore`, `.EntityFrameworkCore`, `.Redis`, `.MongoDB`, `.DynamoDB`, `.Cassandra`, `.Elasticsearch`, `.OpenSearch`, `.CosmosDb`, `.Firestore` | `PROJECTS` in `nuget.mjs`, `PACKAGES` in `tools/check-packages.py` | `check-packages.py` restores every store package from the archives, registers the first three guards and loads the five batch-two builders |
| Maven | seven framework modules plus `sendproof-redis`, `-mongodb`, `-dynamodb`, `-cassandra`, `-elasticsearch`, `-cosmosdb`, `-firestore` | `MODULES` and `STORE_MODULES` in `maven.mjs`; `adapters/java/settings.gradle.kts` | `consumers/maven` resolves the seven store guards (`storesCheck`) |
| crates.io | `sendproof-core`, `-axum`, `-sqlx`, `-actix`, `-redis`, `-dynamodb`, `-mongodb`, `-cassandra`, `-elasticsearch` | `CRATES` in `crates.mjs` | `consumers/crates/main.rs` builds against all five store crates (Cosmos DB and Firestore are unsupported in Rust) |
| Go | core, `chi`, `gin`, `echo`, `gorm`, `redisbench`, `dynamobench`, `mongobench`, `cassandrabench`, `searchbench`, `cosmosbench`, `firestorebench` | `adapters/go/scripts/{package,tags,make-zips,test,verify-release}.sh`, `MODULE_COUNT` in `go.mjs` | `adapters/go/scripts/consumer/main.go.tmpl` imports every module |
| PyPI, RubyGems, Packagist | no store packages | | The Python, Ruby and PHP store hooks ship inside `sendproof-core`, the `sendproof-core` gem and `sendproof/core`, so there are no extra packages or Packagist mirror repositories. `pypi.mjs` imports every hook module from the installed wheel and `check_dist.py` checks the eight client extras; `packagist.mjs` leaves `adapters/php/core/compat/` (the Elasticsearch 8 test run) out of the archive and checks it is absent |

After a module's `pack` returns, `pack-all` writes `RELEASE.json` (registry, version, repository, commit,
files) and `SHA256SUMS` into its output directory. CI uploads that directory unchanged, and every publish
job re-checks `SHA256SUMS` before uploading anything.

## Module contract

```js
export const title = 'npm';                              // shown in the summary table
export async function available(ctx) { return null; }    // or a reason string when a toolchain is missing
export async function pack(ctx) { return ['a.tgz']; }   // write archives into ctx.out, return their names
export async function verify(ctx) {}                     // consumer smoke test, reading only ctx.out
export function registryVersion(versions) { return versions.pep440; } // optional, for RELEASE.json
```

`ctx` holds:

| Field | Meaning |
| --- | --- |
| `version` | SemVer release version, `X.Y.Z` or `X.Y.Z-(alpha\|beta\|rc).N` |
| `versions` | `{ semver, pep440, rubygems, prerelease, npmTag }` |
| `repository` | `{ url, host, owner, name }` from `adapters/go/MODULE_PATH`, the only source of the repository URL |
| `metadata` | `{ authors, license, homepage, issues, keywords }` shared by every registry |
| `commit` | the git commit being packed, or `null` |
| `out` | empty output directory for this registry's archives |
| `work` | empty scratch directory for staging copies, removed afterwards unless `--keep` |
| `keep`, `release` | `--keep` and `--release` flags |
| `log(message)` | prefixed progress output |

## Rules for modules

- **Never edit tracked files while packing.** Copy a package into `ctx.work` with `stage()` and stamp the
  version, repository URL, homepage and issue links into the copy. Generated UI bundles go where the
  binding's existing scripts already put them (they are git-ignored).
- **Stamp, don't duplicate.** Tracked manifests keep their static metadata (description, keywords, licence,
  authors, README). The version and repository come from `ctx` only.
- **Smoke-test the archive, not the source.** `verify` creates a throwaway project with `tempDir()` (outside
  the repository, so no workspace file applies), installs the archives from `ctx.out`, starts a minimal
  application on `127.0.0.1:$PORT` and calls `smokeServe()`, which checks `/sendproof/`, `/sendproof/app.js`,
  `/sendproof/_api/capabilities` and the OpenAPI document it names. Remove the project unless `ctx.keep`.
- **Stay portable.** Spawn tools with `run()`/`output()` and argument arrays, never through `bash -c`; use
  `isWindows`, `venvPython()` and `findPython()` for platform differences. The same module runs on Linux,
  macOS and Windows in CI.
- **Fail loudly.** Check required metadata and archive contents in `pack` and throw with a clear message.

All helpers are in `lib.mjs`.
