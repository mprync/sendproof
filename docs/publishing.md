# Publishing Sendproof packages

Sendproof ships every binding to its language's registry from one version tag. CI builds each registry's packages once, installs them into fresh consumer applications on Linux, Windows and macOS, and only then lets the publish jobs upload the exact, checksum-verified artifacts. This guide is the one-time setup a maintainer does by hand, in order, followed by the release procedure.

Nothing here has been done yet: no trusted publisher or secret exists. Placeholders below:

- `OWNER/REPO`: the final GitHub repository, for example `mprync/sendproof`.
- Workflow file: always `check.yml` (`.github/workflows/check.yml`).
- Environment: the GitHub environment named per registry below.

## What each tag publishes

| Registry | Packages | GitHub environment | Credentials |
| --- | --- | --- | --- |
| nuget.org | `Sendproof.AspNetCore`, `Sendproof.EntityFrameworkCore`, `Sendproof.Redis`, `Sendproof.MongoDB`, `Sendproof.DynamoDB`, `Sendproof.Cassandra`, `Sendproof.Elasticsearch`, `Sendproof.OpenSearch`, `Sendproof.CosmosDb`, `Sendproof.Firestore` (+ symbols) | `nuget` | OIDC trusted publishing, secret `NUGET_USER` |
| npmjs.com | seventeen `@sendproof/*` packages, with provenance | `npm` | OIDC trusted publishing |
| PyPI | `sendproof-core`, `-sqlalchemy`, `-fastapi`, `-flask`, `-django` | `pypi` | OIDC trusted publishing, attestations |
| Maven Central | `io.github.mprync:sendproof-{core,ui,jdbc,logback,spring-boot,jpa,ktor,redis,mongodb,dynamodb,cassandra,elasticsearch,cosmosdb,firestore}` | `maven-central` | Central Portal token + GPG key (secrets) |
| crates.io | `sendproof-core`, `-axum`, `-actix`, `-sqlx`, `-redis`, `-dynamodb`, `-mongodb`, `-cassandra`, `-elasticsearch` | `crates-io` | OIDC trusted publishing |
| RubyGems.org | `sendproof-core`, `sendproof-activerecord`, `sendproof-rails` | `rubygems` | OIDC trusted publishing |
| Packagist | `sendproof/core`, `sendproof/laravel`, `sendproof/symfony` via split repositories | `packagist` | GitHub App token for the split repositories |
| Go proxy | `adapters/go`, `/chi`, `/gin`, `/echo`, `/gorm`, `/redisbench`, `/dynamobench`, `/mongobench`, `/cassandrabench`, `/searchbench`, `/cosmosbench`, `/firestorebench` modules via tags | `go` | the job's `GITHUB_TOKEN` (`contents: write`) |

The data-store hooks for Python, Ruby and PHP (Redis, DynamoDB, MongoDB and the batch-two Cassandra, Elasticsearch, OpenSearch, Cosmos DB and Firestore ones, where each language supports them) ship inside `sendproof-core`, the `sendproof-core` gem and `sendproof/core` (client libraries are optional extras or `suggest` entries), so those registries and the Packagist mirror repositories gain no packages. The Packagist archives leave out `compat/` in `sendproof/core`, the Elasticsearch 8 test run.

## Package names

The names come from the rename recorded in [the rename plan](plans/rename-sendproof.md) (2026-11-21). The repository and the npm organisation `@sendproof` belong to the account `mprync`; there is no GitHub organisation. Availability of the other registry names has not been checked since the rename, so check each one just before setting it up, because names can be claimed at any time.

| Registry | Name | Note |
| --- | --- | --- |
| npm | scope `@sendproof` (`@sendproof/core` and the other sixteen, including the data-store guards `redis`, `dynamodb`, `mongodb`, `cassandra`, `elasticsearch`, `cosmosdb` and `firestore`) | The organisation exists and is owned by `mprync`. |
| PyPI | `sendproof-core`, `sendproof-sqlalchemy`, `sendproof-fastapi`, `sendproof-flask`, `sendproof-django` | Not yet checked. |
| Maven Central | group `io.github.mprync`, artifacts `sendproof-*` | Verified automatically when signed in to Central with the `mprync` GitHub account; no domain is needed. |
| crates.io | `sendproof-core`, `sendproof-axum`, `sendproof-actix`, `sendproof-sqlx`, `sendproof-redis`, `sendproof-dynamodb`, `sendproof-mongodb`, `sendproof-cassandra`, `sendproof-elasticsearch` | Not yet checked. |
| RubyGems | `sendproof-core`, `sendproof-activerecord`, `sendproof-rails` | Not yet checked. |
| Packagist | vendor `sendproof` (`sendproof/core`, `/laravel`, `/symfony`), mirror repositories `mprync/sendproof-*` | Not yet checked. |
| nuget.org | `Sendproof.AspNetCore`, `Sendproof.EntityFrameworkCore`, `Sendproof.Redis`, `Sendproof.MongoDB`, `Sendproof.DynamoDB`, `Sendproof.Cassandra`, `Sendproof.Elasticsearch`, `Sendproof.OpenSearch`, `Sendproof.CosmosDb`, `Sendproof.Firestore` | Not yet checked; reserving the `Sendproof.` ID prefix may be refused if another owner holds a similar ID. |
| GitHub | `github.com/mprync/sendproof` | `adapters/go/MODULE_PATH` names it. |

## Checklist

Work top to bottom. Steps 1 to 3 are needed before any registry; the registry sections can then be done in any order, and a registry that is not set up simply fails its own publish job.

### 1. Create the repository and point the build at it

1. Create `OWNER/REPO` on GitHub and push `main`.
2. Retarget the repository identity. `adapters/go/MODULE_PATH` is the single source of the repository URL for every registry (npm `repository`, PyPI `Project-URL`, POM `scm`, crate `repository`, gem `source_code_uri`, Composer `support`, NuGet `RepositoryUrl`), so changing it changes them all:

   ```sh
   node tools/set-go-module-path.mjs github.com/OWNER/REPO
   node tools/pack-all.mjs --verify      # every registry whose toolchain you have
   git commit -am "Point packages at github.com/OWNER/REPO"
   ```

   A tag build refuses to publish if `MODULE_PATH` and the repository the workflow runs in disagree.
3. In **Settings → Actions → General**, keep the default `GITHUB_TOKEN` permission at read-only (the workflow requests more per job).

### 2. Create the GitHub environments

In **Settings → Environments**, create these eight environments: `nuget`, `npm`, `pypi`, `maven-central`, `crates-io`, `rubygems`, `packagist`, `go`. For each:

- **Deployment branches and tags:** "Selected branches and tags", add the tag rule `v*`.
- **Required reviewers:** add the release maintainers (recommended; every publish then waits for approval).
- Add the environment secrets and variables listed in that registry's section below. Use environment secrets, not repository secrets, so only that job can read them.

### 3. Protect release tags

In **Settings → Rules → Rulesets**, add a tag ruleset targeting `v*` that restricts creation, update and deletion to maintainers, and a second ruleset for `adapters/go/*` that allows only maintainers and GitHub Actions to create tags (the `go` job creates them) and blocks updates and deletion.

Make the `Verify`, `Protocol` and `Packages` checks required on `main`.

### 4. nuget.org

1. Sign in at nuget.org with the publishing account (or create an organisation and add maintainers).
2. **Trusted publishing:** under your profile → *Trusted Publishing*, add a GitHub Actions policy: owner `OWNER`, repository `REPO`, workflow file `check.yml`, environment `nuget`. Allow it to push new packages so the first release can create both IDs.
3. In environment `nuget`, add secret `NUGET_USER` = the nuget.org **profile name** that owns the policy (not an email address).
4. Optional: request ID prefix reservation for `Sendproof.` (see the name table above).

### 5. npm

1. Sign in as `mprync`, the owner of the `@sendproof` npm organisation, which the seventeen packages publish under.
2. Enable two-factor authentication on every maintainer account.
3. npm only lets you add a trusted publisher to a package that already exists, so the **first** version is published by hand from the verified CI artifact: download `packages-npm` from the tag's workflow run, check it with `sha256sum --check SHA256SUMS`, then publish in the order `RELEASE.json` lists (core, sqlite, then the rest) with `npm publish <file>.tgz --access public --tag next` (`latest` for a stable version).
4. For each package on npmjs.com → *Settings* → *Trusted publishing*, add GitHub Actions: organisation or user `OWNER`, repository `REPO`, workflow `check.yml`, environment `npm`. Then set *Publishing access* to "Require two-factor authentication and disallow tokens".
5. No secret is needed. From then on the job's npm (11.5.1 or newer, bundled with Node 24) exchanges its OIDC token and publishes with provenance.

### 6. PyPI

1. Create a PyPI account with two-factor authentication.
2. At *Your account → Publishing*, add a **pending publisher** for each of the five projects: PyPI project name (`sendproof-core`, `sendproof-sqlalchemy`, `sendproof-fastapi`, `sendproof-flask`, `sendproof-django`), owner `OWNER`, repository `REPO`, workflow `check.yml`, environment `pypi`. The first release creates the projects.
3. No secret is needed. `pypa/gh-action-pypi-publish` uploads with digital attestations.

### 7. Maven Central

1. Create an account at [central.sonatype.com](https://central.sonatype.com).
2. **Namespace:** sign in to Central with the `mprync` GitHub account, which verifies `io.github.mprync` automatically; no DNS record is needed.
3. **User token:** *Account → Generate User Token*. In environment `maven-central`, add secrets `MAVEN_CENTRAL_USERNAME` and `MAVEN_CENTRAL_PASSWORD` with the token's two halves.
4. **Signing key:** create a dedicated key and publish its public half:

   ```sh
   gpg --quick-generate-key "Sendproof releases <releases@your-domain>" ed25519 sign 2y
   gpg --keyserver keys.openpgp.org --send-keys <KEYID>
   gpg --keyserver keyserver.ubuntu.com --send-keys <KEYID>
   gpg --armor --export-secret-keys <KEYID>   # value of MAVEN_GPG_PRIVATE_KEY
   ```

   Add secrets `MAVEN_GPG_PRIVATE_KEY` (the armored private key) and `MAVEN_GPG_PASSPHRASE`. Keep a revocation certificate offline.
5. The job signs every jar, POM and Gradle module file, adds MD5/SHA-1 checksums, uploads one bundle with `publishingType=AUTOMATIC` and waits until the Central Portal reports `PUBLISHED`. Signing happens only in this job, so the key never reaches the build that ran untrusted pull-request code.

### 8. crates.io

1. Sign in to crates.io with GitHub and verify your email address.
2. crates.io only accepts trusted publishing for crates that already exist, so publish the **first** version by hand from the verified artifact: create an API token with the `publish-new` scope limited to `sendproof-*` and a short expiry, download `packages-crates`, check `SHA256SUMS`, then run `CARGO_REGISTRY_TOKEN=<token> node tools/release/publish.mjs crates <dir> --tag vX.Y.Z` (it unpacks each `.crate` and publishes core first). Revoke the token afterwards.
3. For each of the nine crates → *Settings* → *Trusted Publishing*, add GitHub: owner `OWNER`, repository `REPO`, workflow `check.yml`, environment `crates-io`. Optionally enable "trusted publishing only".
4. No secret is needed afterwards. `rust-lang/crates-io-auth-action` exchanges the OIDC token for a 30-minute publish token.

### 9. RubyGems.org

1. Create an account with MFA enabled (the gemspecs set `rubygems_mfa_required`).
2. At *Settings → Trusted publishers → Pending trusted publishers*, add one per gem (`sendproof-core`, `sendproof-activerecord`, `sendproof-rails`): repository owner `OWNER`, repository `REPO`, workflow `check.yml`, environment `rubygems`.
3. No secret is needed. `rubygems/configure-rubygems-credentials` exchanges the OIDC token before `gem push`.

### 10. Packagist (split repositories)

Packagist reads `composer.json` at the root of a repository, and the PHP packages live in subdirectories of this monorepo. Like Symfony and Laravel, Sendproof publishes each PHP package to its own read-only mirror repository. Because the embedded workbench UI is generated, not tracked, each mirror receives the verified release tree (the Packagist ZIP built by CI, UI included) as one commit per release, tagged `vX.Y.Z`, rather than a history-preserving subtree split.

1. Create three empty public repositories: `OWNER/REPO-php-core`, `OWNER/REPO-php-laravel`, `OWNER/REPO-php-symfony`. Describe them as read-only mirrors and disable issues and pull requests. (Different names: set repository variable `PACKAGIST_SPLIT_PREFIX`, for example `OWNER/sendproof-php-`, and update the repository list in the `publish-packagist` job.)
2. Create a GitHub App owned by `OWNER` with **Repository permissions → Contents: Read and write** only, no webhook, and install it on just those three repositories.
3. Add repository variable `SPLIT_APP_ID` (the App ID) and, in environment `packagist`, secret `SPLIT_APP_PRIVATE_KEY` (a generated private key). The job mints a one-hour token for the three mirrors only.
4. After the first release has pushed to the mirrors, sign in to packagist.org with GitHub, submit each mirror's URL at *Submit*, and confirm the GitHub hook is active (*Profile → Settings → GitHub hook sync*) so later tags appear within minutes. The packages claim vendor `sendproof`.

### 11. Go modules

1. No registry account is needed: Go resolves modules from the repository's tags through `proxy.golang.org`.
2. Allow GitHub Actions to create `adapters/go/*` tags (step 3). The `go` environment needs no secrets.
3. The job pushes `adapters/go/vX.Y.Z` first and the eleven other modules (four frameworks and the `redisbench`, `dynamobench`, `mongobench`, `cassandrabench`, `searchbench`, `cosmosbench` and `firestorebench` store modules) after it, then waits until the public proxy serves each one. Tags are immutable in the Go checksum database: never move or delete one.

## Release a version

1. **Choose the version.** `X.Y.Z` or `X.Y.Z-alpha.N`, `-beta.N`, `-rc.N`; these are the only prerelease forms every registry can express (PyPI `1.2.0a1`, RubyGems `1.2.0.alpha.1`, npm dist-tag `next`).
2. **Bump the Go requirements.** Each framework module must require the core at the release version, and `adapters/go/go.work` must map that version to the local modules; `adapters/go/scripts/package.sh` fails otherwise. Then run `adapters/go/scripts/tidy.sh`. Optionally bump `VersionPrefix`/`VersionSuffix` in `Directory.Build.props`, the default version for untagged builds. Every other registry's version is stamped from the tag at pack time.
3. **Rehearse locally:** `node tools/pack-all.mjs --verify --version X.Y.Z[-rc.N]`.
4. **Tag and push** the reviewed commit on `main`: `git tag vX.Y.Z && git push origin vX.Y.Z`.
5. The workflow runs every check on all three operating systems, builds the packages once, rehearses each upload, then queues eight publish jobs. Approve each environment when prompted.
6. Confirm each registry shows the version, then publish the GitHub release notes from `CHANGELOG.md`.

## Recover from a partial release

Registries never allow a published version to be replaced, so a failed publish job is never fixed by rebuilding or retagging.

1. Open the failed job. `publish.mjs` uploads in dependency order and stops at the first failure, so the log shows exactly which packages were accepted.
2. Download the same run's `packages-<registry>` artifact and check `sha256sum --check SHA256SUMS`.
3. Upload only the missing files with that registry's normal client and a short-lived, narrowly scoped credential (for example `npm publish file.tgz`, `dotnet nuget push file.nupkg`, `gem push file.gem`, or `node tools/release/publish.mjs crates <dir>` after removing published crates from the directory). Re-running the whole publish job is safe only for registries where nothing was accepted.
4. If published contents are wrong, release a new patch version instead.

## Build and verify locally

`node tools/pack-all.mjs` builds every registry whose toolchain is installed into `artifacts/packages/<registry>/`, each with `SHA256SUMS` and `RELEASE.json`. `--verify` installs the archives (never the source tree) into throwaway consumer applications and checks that each serves the workbench at `/sendproof/` and its OpenAPI document. `--only npm,pypi` limits the run; `node tools/pack-all.mjs --help` lists every option. `node tools/release/publish.mjs <registry> artifacts/packages/<registry> --tag vX.Y.Z --dry-run` shows what a publish job would upload. Module details are in [tools/release/README.md](../tools/release/README.md).
