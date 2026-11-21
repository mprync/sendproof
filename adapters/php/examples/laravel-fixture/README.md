# Laravel conformance fixture

A disposable Laravel app that implements the [conformance fixture](../../../../spec/conformance/fixture.md): one SQLite table `items`, signed-cookie authentication with an admin and a viewer, and the preview-enabled operations the shared runner exercises.

```sh
sh adapters/php/scripts/prepare.sh          # install dependencies and embed the UI bundle
PORT=5361 BENCH_PATH_BASE=/tenant BENCH_SCENARIO=standard php adapters/php/examples/laravel-fixture/serve.php
node tests/conformance/run.mjs php-laravel   # from the repository root
```

`serve.php` creates an empty SQLite database and trace directory under the system temp directory, then replaces itself with `php -S 127.0.0.1:$PORT`. Requests outside `BENCH_PATH_BASE` return 404. `BENCH_SCENARIO` is `standard`, `disabled` (production environment), `no-provider`, or `rollback-failure` (a provider that rolls back for real, then reports failure). Traces live for five seconds.

This is test code, not an example of production authentication.
