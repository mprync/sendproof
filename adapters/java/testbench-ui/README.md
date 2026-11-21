# testbench-ui

The shared Test Bench workbench UI as classpath resources under `testbench-ui/`. This module has no source files: Gradle runs the shared packer

```sh
node tools/pack-ui.mjs --version <version> --out adapters/java/testbench-ui/build/ui-bundle
```

and embeds its output (`manifest.json` with `{version, bundleHash, files}` plus the original files). The UI is never copied into or forked in this repository. Building from source therefore needs Node on the `PATH` (override with `-PnodeExecutable=/path/to/node`).

`testbench-core`'s `WorkbenchAssets` serves only files listed in the manifest, with the recorded content type, and verifies each file's SHA-256 before first use.
