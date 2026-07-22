# Vibeable

Vibeable is a source-available, self-hosted AI application builder for company teams. A user describes a product or change, watches the workspace update in a live preview, and keeps the result in Git. Administrators control who can build, which providers and models are available, which technology stacks are allowed, how much may be spent, and how reviewed commits reach an existing deployment platform.

This repository is a self-hosted community edition, not a claim of feature-for-feature or security equivalence with Lovable. It is useful today for trusted company teams building web workspaces through an OpenAI-compatible endpoint. Read [Production readiness](docs/production-readiness.md) before allowing untrusted users or enabling command execution.

## Where it fits

Vibeable works well when you want to:

- Give internal product, design, and engineering teams a shared prompt-to-code workspace rather than individual unmanaged AI subscriptions.
- Use OpenRouter, a hosted OpenAI-compatible API, or an approved internal endpoint without exposing provider keys to browsers.
- Keep every successful AI change as an attributed Git commit and continue improving the same project over time.
- Restrict a team to approved languages, frameworks, dependencies, package managers, required files, or container base images.
- Make Kubernetes, Helm, Docker Swarm, Compose, GitOps, or webhook delivery conform to company-specific profiles and approval rules.
- Track tokens and estimated cost globally or by team, user, and project.

It is not currently a safe multi-tenant public SaaS runtime, a replacement for a CI system, or a managed hosting platform for arbitrary generated backends. The built-in preview is authenticated and static; verification and deployment are separate operator-controlled capabilities.

## Product tour

### Builder and live preview

![Vibeable builder with a completed agent timeline and a live generated technology digest application](docs/screenshots/builder.jpg)

### Technology and delivery governance

![Vibeable enforced stack profiles and team-scoped deployment adapters](docs/screenshots/delivery.jpg)

### Scoped token usage

![Vibeable project-scoped token usage for a real OpenRouter build](docs/screenshots/usage.jpg)

### Teams and AI governance

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/teams.jpg" alt="Vibeable teams, users, and role administration"></td>
    <td width="50%"><img src="docs/screenshots/governance.jpg" alt="Vibeable OpenAI-compatible providers and scoped AI policies"></td>
  </tr>
</table>

Screenshots use local demo records and contain no production credentials.

## How teams use it

1. An owner deploys Vibeable with durable PostgreSQL and workspace storage, then creates the organization and first provider.
2. An administrator creates teams, assigns roles, and optionally connects OIDC for company login.
3. Administrators define allowed AI providers/models, scoped budgets, prompt hooks, technology profiles, and deployment profiles.
4. A developer creates a project, connects an empty or related-history HTTPS Git remote, chooses an approved model, and describes a change.
5. Vibeable resolves policy, supplies bounded workspace/resource/log context, requests structured edits, validates the workspace, commits the result, and updates the preview.
6. The team iterates on `main` or branch-bound workers, promotes reviewed branches, and optionally auto-pushes successful runs.
7. A developer creates an exact-commit deployment plan. Production plans require a different authorized user to approve them when separate approval is enabled.
8. Old projects can stay archived locally, be offloaded to Git and restored later, or be moved through trash before owner-only purge.

See the [User guide](docs/user-guide.md) for the complete workflow and the [Operator guide](docs/operator-guide.md) for installation, upgrades, backups, and execution modes.

## Capabilities

- First-run organization and owner bootstrap, local password login, generic OIDC authorization-code SSO with PKCE, and opaque server-side sessions.
- Organization and team membership with owner, admin, developer, reviewer, and viewer roles.
- PostgreSQL-backed projects, runs, policies, hooks, usage, deployments, and audit events.
- OpenRouter or any compatible `/chat/completions` endpoint with encrypted API keys.
- Per-run provider and model dropdowns constrained by the effective policy, with the provider default identified as the recommended model; administrators can edit endpoints, models, prices, keys, and availability.
- Global, team, user, and project policy inheritance with hard provider/model intersections.
- Automatic lifecycle intent selection plus scoped prompt hooks and approval flags.
- Structured AI file edits with path traversal and binary/context limits.
- Git-backed projects with a run-specific agent branch, an exact resulting commit, and attribution metadata on changed commits.
- Configurable HTTPS Git remotes, encrypted bearer/basic credentials, pull/push, mirror offload and restore, branch promotion, and branch-bound logical workers with optional auto-push.
- Active, archived, offloaded, and trash project views with guarded restore and owner-only permanent purge.
- Enforceable global, team, or project technology profiles for languages, frameworks, package managers, dependencies, required files/scripts, and container base images.
- Persisted progress, elapsed time, per-file events, reconnecting SSE, and polling fallback.
- Preview console/error capture and build logs fed into the next repair or agent pass as untrusted diagnostic context.
- Write-only project secrets, API/SMTP/service/Git metadata, and project-isolated managed PostgreSQL credentials.
- One automatic repair pass when workspace verification fails; every provider attempt is included in token and cost accounting.
- Authenticated live preview with desktop, tablet, and mobile sizing.
- Selectable global, team, user, and project token/cost dashboards.
- Team/project deployment profiles for Kubernetes, Helm, Docker Swarm, Compose, GitOps, or webhooks, with exact-commit plans, selected secret injection, event logs, health checks, production approval, execution, and rollback records.
- Docker Compose packaging, checksummed migrations, health checks, PostgreSQL integration tests, CI, and security documentation.

## Documentation

| Document | Use it for |
| --- | --- |
| [User guide](docs/user-guide.md) | Roles, providers, policies, building, resources, Git, branch workers, metrics, deployment, and project lifecycle |
| [Operator guide](docs/operator-guide.md) | Durable installation, configuration, upgrades, backups, restore, execution modes, and monitoring |
| [OIDC setup](docs/oidc.md) | Company SSO, provisioning, role mapping, and team mapping |
| [Architecture](docs/architecture.md) | Components, trust boundaries, run lifecycle, Git behavior, and delivery lifecycle |
| [Production readiness](docs/production-readiness.md) | Supported deployment boundary and remaining release gates |
| [Threat model](docs/threat-model.md) | Security controls, residual risks, and non-negotiable deployment rules |
| [Security audit](docs/security-audit.md) | Point-in-time dependency, secret, container, license, and manual review coverage |
| [Specification](SPEC.md) | Product direction, design vocabulary, and broader roadmap; not a guarantee that every described feature is implemented |

## Quick start with Docker

Requirements: Docker with Compose v2.

```bash
cp .env.compose.example .env
openssl rand -base64 32
```

Set `POSTGRES_PASSWORD`, `MASTER_KEY`, and `PUBLIC_URL` in `.env`, then run:

```bash
docker compose up --build
```

Open `http://localhost:8787`. The first browser creates the organization owner and AI provider. The example disables Secure cookies only for this local HTTP setup. Set `PUBLIC_URL` to an HTTPS URL and `COOKIE_SECURE=true` for every network deployment. Keep `EXECUTION_MODE=disabled` until you have reviewed the sandbox guidance.

After bootstrap, follow [Create the first governed project](docs/user-guide.md#create-the-first-governed-project). For a long-lived project, configure its HTTPS remote in the **Git** tab before the first production-bound iteration.

## Local development

Requirements: Node.js 22+, pnpm 11, Git 2.28+, and PostgreSQL 15+.

```bash
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm dev
```

The web UI runs at `http://127.0.0.1:5173`; the API runs at `http://127.0.0.1:8787`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | local PostgreSQL | Primary database connection |
| `DATABASE_SSL` | `disable` | `disable`, `require`, or CA-verified `verify-full` |
| `MASTER_KEY` | development-only value | Encrypts provider API keys; mandatory to change in production |
| `PUBLIC_URL` | `http://127.0.0.1:8787` | Allowed browser origin and canonical URL |
| `COOKIE_SECURE` | production-dependent | Requires HTTPS for session cookies |
| `LOCAL_LOGIN_ENABLED` | `true` | Keeps local account login available for recovery |
| `OIDC_ENABLED` | `false` | Enables generic OIDC single sign-on; see [OIDC setup](docs/oidc.md) |
| `REQUIRE_SEPARATE_APPROVER` | `true` | Prevents users approving their own governed runs or deployments |
| `TRUST_PROXY` | `false` | Trust reverse-proxy forwarding headers |
| `EXECUTION_MODE` | `disabled` | `disabled`, `local`, or `docker` workspace verification |
| `DEPLOYMENT_EXECUTION_MODE` | `disabled` | `disabled` or `local` allowlisted deployment adapters |
| `ALLOW_PRIVATE_AI_ENDPOINTS` | `false` | Allows HTTP/private OpenAI-compatible endpoints |
| `DATA_DIR` | `.vibeable` | Project workspace storage |

`local` execution runs generated package scripts on the host and is only for a trusted developer machine. Shared installations should use a separately hardened Docker worker; see the threat model.

Static previews never receive secret values. Managed PostgreSQL creates an isolated role and schema; generated backends still require an application runtime worker. Deployment profiles receive only explicitly named resources. Keep deployment execution disabled in the default control-plane container: `local` adapters require operator-installed `kubectl`, `helm`, or `docker` binaries and should run in a dedicated worker. The webhook and GitOps adapters are the safer integration points for an existing deployment controller.

## Development commands

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

The broader product design and roadmap remain in [SPEC.md](SPEC.md). Current behavior is documented by the README, [User guide](docs/user-guide.md), [Operator guide](docs/operator-guide.md), [Architecture](docs/architecture.md), and implementation. Production dependency licenses are reproduced in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Community

Vibeable is dual-licensed for perpetual internal company use or noncommercial community use. Commercial redistribution and hosted-service use require a separate license. Read [LICENSE](LICENSE) and [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md) before use or distribution. Start contributions with [CONTRIBUTING.md](CONTRIBUTING.md), report vulnerabilities through [SECURITY.md](SECURITY.md), and follow the [Code of Conduct](CODE_OF_CONDUCT.md).
