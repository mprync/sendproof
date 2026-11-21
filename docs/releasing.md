# Releasing NuGet packages

Both adapters ship together at the same version. Release builds are produced and
tested from the tagged commit by `.github/workflows/check.yml`; the publishing
job downloads those exact artifacts after the release checks and binding conformance matrix pass. No repository owner,
package ownership or nuget.org identity is assumed by this repository.

## Before the first release

1. Confirm that `TestBench.AspNetCore` and `TestBench.EntityFrameworkCore` are
   available on nuget.org and that the intended account owns or may publish them.
2. Configure a nuget.org [trusted publishing policy](https://learn.microsoft.com/en-us/nuget/nuget-org/trusted-publishing)
   for the actual GitHub owner and repository, workflow filename `check.yml`,
   and environment `nuget`. Grant the policy the scopes needed to publish both
   package IDs, including new packages if applicable.
3. Set the GitHub environment secret `NUGET_USER` to the nuget.org profile name
   used for the policy, not an email address. Configure environment protection
   and tag permissions to match the maintainers' release policy.
4. Run the workflow on the intended default branch and make its `verify` check
   required in that branch's ruleset. The workflow summary shows each build and
   test outcome. To display a live build badge in the README, use **Create status
   badge** in the workflow's Actions menu after the repository has its public URL.

## Verify locally

With the .NET 10 SDK, Node.js 22+, Python 3 and Chromium installed, run the
checks in [CONTRIBUTING.md](../CONTRIBUTING.md). Then, from a clean package
output directory, use the intended version for both packages:

```sh
dotnet pack adapters/dotnet/TestBench.AspNetCore -c Release -o artifacts/packages -p:Version=0.1.0-alpha.1
dotnet pack adapters/dotnet/TestBench.EntityFrameworkCore -c Release -o artifacts/packages -p:Version=0.1.0-alpha.1
python3 tools/check-packages.py artifacts/packages
```

The package gate inspects the archives and restores a clean consumer. The CI
build also sets `ContinuousIntegrationBuild`, the repository URL and the tag's
version before building, testing and packing. The .NET SDK supplies Source Link
for supported Git hosts; portable symbols are delivered in `.snupkg` files.
CI retains both packages, symbols and SHA-256 checksums as an artifact, plus
browser evidence even if the browser check fails.

## Publish intentionally

After reviewing the exact commit and completing the setup above, push a tag of
the form `v1.2.3` or `v1.2.3-rc.1`. A tag push invokes the entire verification
job; only its success permits the `nuget` environment publishing job. GitHub
OIDC exchanges a token for a short-lived nuget.org key immediately before the
push. NuGet's V3 push also sends each matching symbol package. The workflow
does not skip duplicates: if a partial publish fails, inspect nuget.org and
the run before deciding how to recover; published package versions are immutable.

For partial publication, compare both package IDs and symbol status on nuget.org
with the retained artifact and its `SHA256SUMS`. Do not retag or rebuild the same
version. After identifying exactly what is missing, an authorized maintainer can
push only the missing original `.nupkg` (which also attempts its adjacent
`.snupkg`) or the missing `.snupkg` using the NuGet V3 source and appropriately
scoped credentials. Confirm nuget.org acceptance for both packages and symbols.
If the published contents are wrong, release a new version rather than attempting
to replace an existing one. Rerunning the full publishing job encounters already
published packages and is not a safe automatic recovery procedure.

See Microsoft's [symbol package guidance](https://learn.microsoft.com/en-us/nuget/create-packages/symbol-packages-snupkg)
for symbol server behavior. A local pack or passing CI check does not prove
trusted-publishing permissions or nuget.org acceptance; those require an
authorized release run.
