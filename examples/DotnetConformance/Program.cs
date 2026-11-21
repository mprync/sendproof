using DotnetConformance;

// Disposable conformance fixture: configuration comes only from PORT, BENCH_PATH_BASE and BENCH_SCENARIO.
var app = FixtureApplication.Build(FixtureOptions.FromEnvironment(), args);
await app.RunAsync();
