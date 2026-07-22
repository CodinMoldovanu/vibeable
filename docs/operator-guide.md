# Operator guide

This guide covers a durable, single-organization Vibeable installation. The current control plane is designed for one application replica and trusted internal users. Read [Production readiness](production-readiness.md) and the [Threat model](threat-model.md) before exposing it to a network.

## Supported topology

The supported community topology is:

- One Vibeable web/API/orchestrator replica.
- PostgreSQL 15 or newer.
- Durable storage mounted at `DATA_DIR` for project repositories and deployment worktrees.
- TLS termination at a trusted reverse proxy for any non-loopback deployment.
- Controlled outbound HTTPS access to approved AI, Git, webhook, health-check, and OIDC endpoints.

PostgreSQL and `DATA_DIR` are one recovery unit. Git remotes add source durability, but they do not contain policies, users, encrypted resources, usage, approvals, or deployment history.

## Deploy with Docker Compose

Requirements: Docker with Compose v2, enough disk for PostgreSQL and project repositories, and DNS/TLS for the public URL.

```bash
cp .env.compose.example .env
openssl rand -base64 48
```

Put a unique database password in `POSTGRES_PASSWORD`, the generated value in `MASTER_KEY`, and the canonical URL in `PUBLIC_URL`. For anything except loopback HTTP:

```dotenv
PUBLIC_URL=https://vibeable.example.com
COOKIE_SECURE=true
TRUST_PROXY=true
```

Start the service:

```bash
docker compose up --build -d
docker compose ps
curl --fail https://vibeable.example.com/healthz
```

The application container runs checksummed database migrations before starting. The first browser bootstraps the organization, owner, team, provider, and global policy.

The included Compose file persists:

- PostgreSQL in the `postgres-data` volume.
- `DATA_DIR=/data` in the `workspace-data` volume.

Do not remove either volume during routine upgrades.

## Reverse proxy requirements

The proxy must:

- Terminate HTTPS and forward to port `8787`.
- Preserve the original host and scheme.
- Support long-lived server-sent event responses without buffering.
- Apply request/body/time limits compatible with provider and generated-file limits.
- Avoid logging query strings for OIDC callback traffic.

Set `PUBLIC_URL` to the exact browser origin, with no alternate hostname. Set `TRUST_PROXY=true` only when the application is reachable exclusively through a proxy you control.

## Configuration reference

### Core service

| Variable | Default | Operational meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | Use `production` outside local development |
| `HOST` | `127.0.0.1` | Compose sets `0.0.0.0` inside the container |
| `PORT` | `8787` | HTTP listen port |
| `PUBLIC_URL` | `http://127.0.0.1:8787` | Canonical browser origin, CSRF origin, cookie, and OIDC callback base |
| `DATABASE_URL` | Local PostgreSQL URL | Control database and managed development-schema host |
| `DATABASE_SSL` | `disable` | `disable`, `require`, or CA-verified `verify-full` |
| `DATA_DIR` | `.vibeable` | Project repositories and detached deployment worktrees |
| `MASTER_KEY` | Development placeholder | At least 32 characters; encrypts provider and project/Git secrets plus temporary OIDC verifier state |
| `SESSION_TTL_DAYS` | `14` | Opaque server-side session lifetime, from 1 to 90 days |
| `LOG_LEVEL` | `info` | Fastify/Pino log verbosity |
| `COOKIE_SECURE` | Production-dependent | Must be `true` behind HTTPS |
| `TRUST_PROXY` | `false` | Trust proxy forwarding information only behind a controlled proxy |
| `REQUIRE_SEPARATE_APPROVER` | `true` | Prevent self-approval of governed runs and production deployments |

Never rotate `MASTER_KEY` by changing the variable in place. There is no automated re-encryption workflow. Preserve it in the host secret manager and include recovery access in disaster-recovery procedures.

### Authentication

| Variable | Default | Operational meaning |
| --- | --- | --- |
| `LOCAL_LOGIN_ENABLED` | `true` | Local password login and break-glass access |
| `OIDC_ENABLED` | `false` | Generic OIDC authorization-code SSO with PKCE |
| `OIDC_*` | Provider-specific | Issuer, client authentication, claims, mapping, provisioning, and endpoint policy |

See [OIDC setup](oidc.md) for all supported OIDC variables and rollout guidance. Enable SSO only after creating and testing a local owner recovery account.

### Execution and network policy

| Variable | Default | Operational meaning |
| --- | --- | --- |
| `EXECUTION_MODE` | `disabled` | `disabled`, `local`, or `docker` generated-workspace verification |
| `DEPLOYMENT_EXECUTION_MODE` | `disabled` | `disabled` or `local` deployment adapter execution |
| `ALLOW_PRIVATE_AI_ENDPOINTS` | `false` | Allows internal addresses and HTTP for AI endpoints |
| `OIDC_ALLOW_PRIVATE_ENDPOINTS` | `false` | Allows internal IdP endpoint addresses |
| `OIDC_ALLOW_INSECURE_HTTP` | `false` | Allows HTTP IdP endpoints in addition to private addresses |

The standard application image intentionally includes Git but not pnpm, deployment CLIs, Docker socket access, kubeconfig, or cluster credentials. Enabling a mode in configuration does not install its prerequisites.

## Choose a verification mode

### Disabled

Recommended for first deployment. Vibeable validates generated paths and technology-profile rules but does not execute package installation or application builds. This is the safest control-plane mode and is enough for self-contained static workspaces.

### Local

Runs a fixed pnpm install/build command on the Vibeable host with project resources in its environment. Use only on a trusted developer machine. Generated dependencies and build scripts execute with the control plane's authority; this mode is unsupported on a shared server.

### Docker

Runs verification in a network-disabled Node container with CPU, memory, PID, capability, and privilege restrictions. It is safer than local mode but requires access to a Docker daemon, which is itself high authority. Do not mount a general-purpose Docker socket into the public web container. Use a separately designed verification worker before treating this as hostile-code isolation.

## Choose a deployment model

`DEPLOYMENT_EXECUTION_MODE=disabled` still permits immutable deployment planning and approvals. It blocks adapter execution.

Preferred production patterns:

1. **GitOps:** Vibeable pushes an approved exact commit to a configured branch; an existing controller deploys it.
2. **Webhook:** Vibeable sends an exact-commit plan to a constrained deployment service, optionally authenticated by one selected resource.
3. **Dedicated adapter worker:** An independently isolated service owns `kubectl`, Helm, Docker, kubeconfig, and deployment credentials.

`local` deployment mode runs allowlisted adapter binaries from the control-plane host. It does not use a shell, but the installed binary and its credentials still have host or cluster authority. The default image is intentionally not prepared for this mode.

## Outbound network controls

Vibeable validates external URLs, blocks private/special-use addresses by default, disables redirects, pins direct HTTP requests to validated addresses, and bounds responses. Git still performs its own DNS connection after preflight.

Enforce egress at the network layer:

- Allow only approved AI and OIDC endpoints.
- Route Git through approved hosts or a Git proxy.
- Allow deployment webhooks and health endpoints explicitly.
- Deny cloud metadata, control-plane, RFC1918, link-local, and cluster-management networks.
- Keep private endpoint flags off unless this policy is intentionally changed.

## Back up and restore

Back up these together:

1. PostgreSQL, including schema, data, and migration records.
2. The complete `DATA_DIR` volume.
3. The external secret containing `MASTER_KEY` and database credentials.
4. Reverse-proxy and OIDC client configuration.

For a low-traffic Compose installation, stop application writes while capturing both data stores:

```bash
docker compose stop vibeable
docker compose exec -T postgres pg_dump -U vibeable -d vibeable -Fc > vibeable.dump
rm -rf workspace-backup
docker compose cp vibeable:/data ./workspace-backup
docker compose start vibeable
```

Store the dump, workspace archive, and required secrets encrypted. The stopped container remains available to `docker compose cp`; verify this behavior with your Compose implementation before relying on the procedure.

Restore into an isolated environment first:

1. Deploy the same application version and PostgreSQL major version.
2. Stop the Vibeable application container.
3. Restore the PostgreSQL dump into an empty `vibeable` database.
4. Restore the workspace backup to `/data` with ownership matching the application user.
5. Supply the original `MASTER_KEY`.
6. Start the application and verify `/healthz`, login, project lists, previews, Git status, encrypted provider access, and a non-production run.

Offloaded projects do not have local workspace files, but their project record and Git settings still require the PostgreSQL backup.

## Upgrade

Before upgrading:

```bash
git fetch --tags origin
git status --short
```

Read [CHANGELOG.md](../CHANGELOG.md), capture a tested backup, and record the current image/commit. Then:

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail https://vibeable.example.com/healthz
```

Migrations are append-only and run automatically on container start. Application rollback may require restoring the pre-upgrade database and workspace backup; do not assume an older binary can read a migrated database.

## Monitor

At minimum monitor:

- `/healthz` availability and database status.
- Container restarts, disk space, PostgreSQL connections, and volume growth.
- HTTP 5xx, provider timeouts, Git synchronization failures, and deployment failures.
- Token/cost metrics against company limits and provider invoices.
- Audit-event retention required by company policy.
- Backup completion and regular restoration drills.

Application logs are structured JSON. They contain request paths without OIDC query strings and should still be treated as sensitive operational data.

## Recovery scenarios

### Provider key no longer works

An owner or admin edits the provider in **AI governance** and enters a replacement key. Leaving the key blank retains the current encrypted value.

### Lost `MASTER_KEY`

Restore it from the secret manager. There is no supported recovery of encrypted values without the original key. After restoring access, rotate external credentials through the UI if compromise is suspected.

### Workspace volume lost but Git exists

Restore PostgreSQL first. An offloaded project can restore from its configured remote. For an active project, archive/offload state may not match the missing files; recover the workspace backup or use a controlled Git restoration procedure and verify project branch state before accepting runs.

### PostgreSQL lost but Git exists

Git preserves source but not organization records, users, policies, encrypted credentials, resource metadata, metrics, approvals, or deployment history. Restore PostgreSQL from backup; recreating projects manually is not equivalent recovery.

### Run remains active after a process crash

The current orchestrator is in-process and has no durable distributed worker recovery or cancellation UI. Inspect database/run state and logs before operator intervention. Do not run multiple control-plane replicas against the same queue.

## Production gate

Before enabling company-wide access, complete the checklist in [Production readiness](production-readiness.md). Before allowing mutually untrusted users or high-value workloads, the remaining isolation, durable-worker, secret-manager, budget-reservation, browser-test, backup-drill, and independent-review work is mandatory.
