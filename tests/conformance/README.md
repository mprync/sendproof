# Preview session and journey fixtures

Run `node tests/conformance/run.mjs <binding>` after the binding's prepare command. The [shared fixture contract](../../spec/conformance/fixture.md) defines the routes, identities and database settings.

- For `previewSessions: true`, expose the item create, rename and GET routes. Keep the GET handler open for one second when `?hold=true` so simultaneous requests overlap. Use the supplied database and, for SQLite, the file at `BENCH_SQLITE_PATH`.
- For MongoDB, expose the document create and GET routes. For a guarded store, expose the mixed item/store write. The runner checks the guarded step's SQL rollback and reads MongoDB through an independent client.
- For `journeys`, register a sample Arazzo 1.1 journey and expose both advertised documents under the fixture's path base. The workbench's JavaScript modules share that directory.

The [session checks](sessions.mjs) and [discovery checks](journey-discovery.mjs) run independently according to capabilities.
