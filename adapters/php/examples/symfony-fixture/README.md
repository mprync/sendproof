# Symfony conformance fixture

A disposable Symfony + Doctrine app that implements the [conformance fixture](../../../../spec/conformance/fixture.md): one SQLite table `items`, a custom cookie authenticator with an admin and a viewer behind the real security firewall and `access_control`, and the preview-enabled operations the shared runner exercises.

```sh
sh adapters/php/scripts/prepare.sh          # install dependencies and embed the UI bundle
PORT=5374 BENCH_PATH_BASE=/tenant BENCH_SCENARIO=standard php adapters/php/examples/symfony-fixture/serve.php
node tests/conformance/run.mjs php-symfony   # from the repository root
```

`serve.php` creates an empty SQLite database, trace directory and container cache under the system temp directory, then replaces itself with `php -S 127.0.0.1:$PORT`. Requests outside `BENCH_PATH_BASE` return 404. `BENCH_SCENARIO` is `standard`, `disabled` (runs in the `prod` environment), `no-provider`, or `rollback-failure` (a provider that rolls back for real, then reports failure). Traces live for five seconds. The first request after start compiles the container, which takes a moment.

This is test code, not an example of production authentication.
