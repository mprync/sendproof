# Security policy

Sendproof runs inside your API and executes real handlers, so we treat any way out of a Preview's
rollback, any authorization bypass and any leak of secrets into captures as a security issue.

## Report a vulnerability

Please report privately: use **Security → Report a vulnerability** on
[the repository](https://github.com/mprync/sendproof/security/advisories/new). Don't open a public issue
or pull request for a vulnerability.

Include:

- the binding, framework, data provider and their versions, and the database or store involved;
- the authentication method and the affected route or operation;
- the smallest steps that reproduce it on disposable data, and what you observed. For a Preview issue,
  say what a separate read of the database returned afterwards.

Redact tokens, cookies, connection strings and personal records from reports and screenshots.

Once the issue is confirmed we agree a disclosure date with you, and credit you in the advisory unless
you prefer otherwise.

## Supported versions

Sendproof is in prerelease. Fixes land on `main` and in the next release; there are no maintained
older release lines yet.

## Scope and deployment

Sendproof uses the host application's identity and endpoint authorization. It is off unless the
running environment is listed, and is meant for local and hosted development. A hosted environment
should add a workbench access policy and the host's SSO. Seeded personas in the example apps are for
disposable development data.

Preview covers the database connections and store clients the binding hooks, and the effects the
application records. Each binding's guide states that boundary, and the
[security review](docs/security-review.md) lists the escapes found so far, their fixes and the tests
that keep them closed. A write that escapes the documented boundary is in scope; work the guide says
is not covered (calls to other services, files, unhooked clients) is not.
