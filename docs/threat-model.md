# Threat model

## Protected assets

- AI provider credentials and future deployment secrets.
- Source code and generated workspaces.
- Tenant identity, policy, usage, and audit data.
- Host and internal network integrity.

## Primary threats and controls

| Threat | Current control | Residual risk |
| --- | --- | --- |
| Cross-tenant data access | Organization/team constraints, composite database foreign keys, permission checks, and PostgreSQL route tests | Route-level tests must expand with every endpoint |
| Session theft | Random opaque tokens, hash-only storage, HttpOnly/SameSite cookies, Secure in production | Operators must terminate TLS correctly |
| CSRF | SameSite Strict cookie, exact CORS origin, custom mutation header | Reverse proxies must not rewrite origin policy |
| Provider-key disclosure | AES-256-GCM at rest, server-only decryption, exact credential reflection rejection, and log redaction | `MASTER_KEY` rotation is not automated yet |
| Project-secret disclosure | Encrypted values, write-only APIs, metadata-only model context, exact-value and URL-credential log redaction | A production secret-manager integration and automated rotation are still required |
| Provider SSRF | HTTPS-only and private-address blocking by default, DNS validation, address pinning, and redirects disabled | Production deployments still need an outbound egress proxy or network policy |
| Malicious model output | JSON schema, real-path containment, symlink rejection, repository-metadata and secret-file denial, context exclusions, and size limits | Generated application code remains untrusted |
| Host command execution | Disabled by default; Git hooks and global/system Git configuration disabled; Docker resource and privilege limits | Docker daemon access and dependency execution need a separate worker in shared production |
| Preview attacks | Authenticated route, secret and repository-metadata denial, no-store caching, sandboxed iframe, and restrictive CSP | Generated content should move to a separate origin before untrusted multi-user use |
| Log prompt injection | Logs and workspace content are labeled as untrusted data in the system prompt; secret values are redacted before persistence | Model behavior is probabilistic; logs must never grant capabilities or bypass policy |
| Managed database leftovers | Project-specific role/schema, transactional provisioning, idempotent creation, and role/schema removal on resource deletion | Operators still need database backup, monitoring, and connection limits |
| Budget abuse | Effective monthly cap checked before calls, persisted exact usage | Concurrent calls can race the cap without reservations |

## Non-negotiable deployment rules

- Do not set `EXECUTION_MODE=local` on a shared server.
- Do not mount the Docker socket into the web/API container.
- Put generated previews on a separate origin before hosting code from mutually untrusted users.
- Restrict provider egress with a network policy or proxy, even when private endpoints are enabled.
- Back up PostgreSQL and workspace volumes together and test restoration.
- Treat project resource names and URLs as company metadata; secret values remain server-side and must not be copied into prompts.
- Keep `MASTER_KEY` outside Compose files and source control.

See [Production readiness](production-readiness.md) for the release gates that remain.
