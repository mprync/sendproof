# Contributing to Test Bench

Install the .NET 10 SDK to build the packages and example. Browser checks use Node.js 22 or newer and Playwright Chromium. Archive and clean-consumer checks use Python 3.10 or newer, plus each binding's own toolchain for its packages.

## Check a change

```sh
dotnet build TestBench.slnx
dotnet test TestBench.slnx --no-build
node --test tests/ui/*.test.mjs ui/*.test.mjs
npm ci --prefix tools
npx --prefix tools playwright install chromium
node tools/browser-test.mjs
node tools/accessibility.mjs
```

The browser test creates and removes an isolated sample database by default. Pointing `TESTBENCH_URL` at an existing Treasury example will commit a test payment there.

The workflow reports the release build, .NET tests, JavaScript tests and browser checks for each operating system, and every registry's packaging and clean installation, in its run summary. Browser evidence is saved under `artifacts/browser/` and uploaded even after a failed comparison. Each comparison uses the approved mock HTML at the matching viewport. Screenshots retain real API data, so row values, enabled sign-in providers and search result counts can differ from the design fixture.

## Build every package

`node tools/pack-all.mjs` builds every binding into the archive its registry publishes, under `artifacts/packages/<registry>/` with a `SHA256SUMS` file: NuGet packages and symbols, npm tarballs, Python wheels and sdists, a Maven repository layout, `.crate` files, gems, Composer ZIPs and Go module ZIPs. Registries whose toolchain is not installed are skipped and listed in the summary.

```sh
node tools/pack-all.mjs --verify            # build, then install each archive into a fresh consumer app
node tools/pack-all.mjs --verify --only npm,pypi
```

`--verify` creates a throwaway project outside the repository for each registry, installs the built archives (never the source tree) and starts a minimal application that must serve the workbench at `/bench/` and its OpenAPI document. CI runs the same command for each registry on Linux, Windows and macOS. The version comes from `Directory.Build.props` and the repository URL from `adapters/go/MODULE_PATH`. See the [publishing guide](docs/publishing.md) for releases.

## Choose the extension point

| Change | Start here | What to verify |
| --- | --- | --- |
| Another persistence technology in .NET | `IPreviewProvider` and `IPreviewSession` in the ASP.NET Core adapter | The handler uses the enlisted connection, rollback completes before acknowledgement, and errors leave storage consistent. |
| Another server framework | [Bench protocol](spec/README.md) | The same UI can discover the spec, sign in, send, and distinguish a confirmed rollback from failure. |
| A field or schema convention | `ui/schema.js`, or a host module configured with `.WithFieldModule()` | Use a second unrelated OpenAPI example. Keep form and JSON edits interchangeable. |
| Another request export | `ui/snippets.js` | Preserve method, URL, headers, body and preview intent. Cover escaping and credential masking. |
| Another sign-in method | The application's auth handlers and the workbench provider descriptor | Verify a real sign-in and a permission denial with the same session. |

Keep framework dependencies inside their own packages. Document public APIs and any assumptions a host must satisfy, particularly transaction ownership and side effects. Include a regression test when changing behavior that can affect persisted data or authorization.

## Work with the visual reference

The [approved mock states](mocks/README.md) define the interface. Reuse the markup, styles, states and breakpoints. Compare the live feature with the matching desktop and mobile mock, including keyboard navigation, large text and dark mode. When a feature needs an additional design surface, propose a mock for review first. Use `node tools/shoot-mocks.mjs` from the repository root only when intentionally refreshing the reference images.

In a pull request, explain the user-visible change, list the checks run, and include images for visual changes. For a security issue, contact the maintainers privately through the hosting platform's private vulnerability reporting facility if enabled.
