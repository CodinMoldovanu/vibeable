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
| CSRF | SameSite Strict cookie, exact CORS origin, required mutation header on every API mutation, and origin validation when supplied | Reverse proxies must not rewrite origin policy |
| Provider-key disclosure | AES-256-GCM at rest, server-only decryption, exact credential reflection rejection, and log redaction | `MASTER_KEY` rotation is not automated yet |
| Project-secret disclosure | Encrypted values, write-only APIs, metadata-only model context, exact-value and URL-credential log redaction | A production secret-manager integration and automated rotation are still required |
| Provider SSRF | HTTPS-only and private-address blocking by default, DNS validation, address pinning, and redirects disabled | Production deployments still need an outbound egress proxy or network policy |
| Git credential disclosure and SSRF | Credential-free HTTPS URLs, encrypted credentials, disabled prompts/redirects/hooks/global config, bounded subprocesses, and DNS preflight | Git performs its own DNS connection after preflight; enforce egress policy and prefer a dedicated Git proxy for hostile tenants |
| Malicious model output | JSON schema, real-path containment, symlink rejection, repository-metadata and secret-file denial, context exclusions, and size limits | Generated application code remains untrusted |
| Host command execution | Disabled by default; Git hooks and global/system Git configuration disabled; Docker resource and privilege limits | Docker daemon access and dependency execution need a separate worker in shared production |
| Deployment command injection | Strict adapter schemas, validated paths/branches, fixed binary and argument construction, no shell, selected resource injection, bounded redacted output, and execution disabled by default | Local adapters still hold the authority of their kubeconfig, Docker endpoint, or webhook token and belong in a dedicated worker |
| Preview attacks | Authenticated route, secret and repository-metadata denial, no-store caching, iframe sandbox, and response-level CSP sandbox for direct navigation | Generated content should still move to a separate origin before hostile multi-user use |
| Log prompt injection | Logs and workspace content are labeled as untrusted data in the system prompt; secret values are redacted before persistence | Model behavior is probabilistic; logs must never grant capabilities or bypass policy |
| Managed database leftovers | Project-specific constrained role/schema, connection and statement limits, transactional provisioning, idempotent creation, and role/schema removal on resource deletion | Operators still need database backup and monitoring; schemas are not a hostile-tenant boundary |
| Budget abuse | Effective monthly cap checked before calls, persisted exact usage | Concurrent calls can race the cap without reservations |

## Non-negotiable deployment rules

- Do not set `EXECUTION_MODE=local` on a shared server.
- Do not mount the Docker socket into the web/API container.
- Keep `DEPLOYMENT_EXECUTION_MODE=disabled` in the control plane; run adapters in a separately isolated worker or use a constrained webhook controller.
- Put generated previews on a separate origin before hosting code from mutually untrusted users.
- Restrict provider egress with a network policy or proxy, even when private endpoints are enabled.
- Back up PostgreSQL and workspace volumes together and test restoration.
- Treat project resource names and URLs as company metadata; secret values remain server-side and must not be copied into prompts.
- Keep `MASTER_KEY` outside Compose files and source control.

See [Production readiness](production-readiness.md) for the release gates that remain.

Operational deployment, backup, restore, execution-mode, and egress guidance is in the [Operator guide](operator-guide.md). End-user handling of providers, resources, Git, and deployment approvals is in the [User guide](user-guide.md).
