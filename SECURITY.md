# Reporting a security issue

Use **Security → Report a vulnerability** on the hosting repository when private reporting is available. If it is unavailable, open an issue asking a maintainer for a private reporting channel and share the details privately once one is provided.

Include the package versions, host environment, authentication method, affected route and the behavior you observed. Use disposable data and redact tokens, cookies, connection strings and personal records from reports and screenshots.

## Development deployments

Sendproof uses the host application's identity and endpoint authorization. Enable it only in intended development environments. Hosted environments can require a workbench access policy and use the host's SSO. Seeded personas in the Treasury example are for disposable development data.

For reports involving Preview, identify the configured context, persistence provider and any external effects. The [transaction guide](adapters/dotnet/Sendproof.EntityFrameworkCore/README.md) describes what participates in rollback.
