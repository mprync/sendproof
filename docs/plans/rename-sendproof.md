# Rename Test Bench to Sendproof

Approved by the person on 2026-11-21. The repository stays under the GitHub account `mprync`; there is no GitHub organisation.

## Naming map

| Area | Old | New |
| --- | --- | --- |
| Product name in prose and UI | Test Bench | Sendproof |
| Mount path | `/bench` (`/bench/_api`, `/bench/_preview`) | `/sendproof` (`/sendproof/_api`, `/sendproof/_preview`) |
| HTTP headers | `X-TestBench-*` (for example `X-TestBench-Trace`) | `X-Sendproof-*` |
| OpenAPI extensions | `x-testbench-*` | `x-sendproof-*` |
| Environment settings | `TESTBENCH_*` | `SENDPROOF_*` |
| .NET | `TestBench.AspNetCore`, `TestBench.EntityFrameworkCore`, `AddTestBench()`, `TestBenchBuilder`, `[TestBench...]` attributes | `Sendproof.AspNetCore`, `Sendproof.EntityFrameworkCore`, `AddSendproof()`, `SendproofBuilder`, `[Sendproof...]` (for example `[SendproofPreview(...)]`) |
| npm | `@testbench/*` or current names | `@sendproof/core`, `@sendproof/express`, … (the `@sendproof` npm organisation exists, owned by `mprync`) |
| PyPI | current names | `sendproof-core`, `sendproof-fastapi`, …; import package `sendproof` / `sendproof_*` |
| Maven | current group and artifacts | group `io.github.mprync`, artifacts `sendproof-*`, Java package `io.github.mprync.sendproof` |
| crates.io | `testbench-*` | `sendproof-core`, `sendproof-axum`, …; crate idents `sendproof_*` |
| RubyGems | current names | `sendproof-core`, `sendproof-rails`, … (matching the `-core` name on every other registry); Ruby module `Sendproof` |
| Packagist | current names | `sendproof/core`, `sendproof/laravel`, `sendproof/symfony`; PHP namespace `Sendproof\` ; mirror repos `mprync/sendproof-*` |
| Go | current module path | `github.com/mprync/sendproof/...`; package names `sendproof*` |
| Repository URLs | anything pointing at the old repo name | `github.com/mprync/sendproof` |

## Rules

- Rename files and directories too (for example `TestBench.slnx`, `tests/TestBench.AspNetCore.Tests`), using `git mv` so history follows.
- Keep no compatibility aliases for the old names: nothing is published yet, so the old names are simply deleted.
- Translated UI strings: the product name is a proper noun and stays "Sendproof" in every locale.
- Generated files (for example `adapters/go/internal/ui/dist`) are regenerated from source with the repo's own tooling, not hand-edited.
- Do not edit binary screenshots under `mocks/screens`. Mock HTML/JS may be renamed.
- Historical notes under `docs/plans/*-progress.md` may keep old names where they describe past events.
