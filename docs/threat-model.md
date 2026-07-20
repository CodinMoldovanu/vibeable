# Threat model

## Protected assets

- AI provider credentials and future deployment secrets.
- Source code and generated workspaces.
- Tenant identity, policy, usage, and audit data.
- Host and internal network integrity.

## Primary threats and controls

| Threat | Current control | Residual risk |
| --- | --- | --- |
| Cross-tenant data access | Organization/team constraints in project lookups and permission checks | Route-level tests must expand with every endpoint |
| Session theft | Random opaque tokens, hash-only storage, HttpOnly/SameSite cookies, Secure in production | Operators must terminate TLS correctly |
| CSRF | SameSite Strict cookie, exact CORS origin, custom mutation header | Reverse proxies must not rewrite origin policy |
| Provider-key disclosure | AES-256-GCM at rest, log redaction, server-only decryption | `MASTER_KEY` rotation is not automated yet |
| Provider SSRF | HTTPS-only and private-address blocking by default | DNS rebinding protection needs a pinned resolver/egress proxy |
| Malicious model output | JSON schema, path containment, symlink skipping, size limits | Generated application code remains untrusted |
| Host command execution | Disabled by default; Docker resource and privilege limits | Docker daemon access and dependency execution need a separate worker in shared production |
| Preview attacks | Authenticated route, sandboxed iframe, restrictive CSP | Generated content should move to a separate origin before untrusted multi-user use |
| Budget abuse | Effective monthly cap checked before calls, persisted exact usage | Concurrent calls can race the cap without reservations |

## Non-negotiable deployment rules

- Do not set `EXECUTION_MODE=local` on a shared server.
- Do not mount the Docker socket into the web/API container.
- Put generated previews on a separate origin before hosting code from mutually untrusted users.
- Restrict provider egress with a network policy or proxy, even when private endpoints are enabled.
- Back up PostgreSQL and workspace volumes together and test restoration.
- Keep `MASTER_KEY` outside Compose files and source control.

See [Production readiness](production-readiness.md) for the release gates that remain.
