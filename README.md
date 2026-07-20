# Vibeable

Vibeable is a source-available, self-hosted, policy-aware AI application builder for organizations. It combines a conversational coding workflow and authenticated live preview with teams, RBAC, OpenAI-compatible providers, scoped prompt policies, usage accounting, and deployment approvals.

This repository is a self-hosted community edition, not a claim of feature-for-feature or security equivalence with Lovable. It is useful today for trusted company teams building web workspaces through an OpenAI-compatible endpoint. Read [Production readiness](docs/production-readiness.md) before allowing untrusted users or enabling command execution.

## What works

- First-run organization and owner bootstrap, password login, opaque server-side sessions.
- Organization and team membership with owner, admin, developer, reviewer, and viewer roles.
- PostgreSQL-backed projects, runs, policies, hooks, usage, deployments, and audit events.
- OpenRouter or any compatible `/chat/completions` endpoint with encrypted API keys.
- Global, team, user, and project policy inheritance with hard provider/model intersections.
- Lifecycle prompt hooks and approval flags.
- Structured AI file edits with path traversal and binary/context limits.
- Git-backed projects with an agent branch and attributed commit for every successful run.
- Persisted run timelines streamed over SSE.
- Authenticated live preview with desktop, tablet, and mobile sizing.
- Selectable global, team, user, and project token/cost dashboards.
- Independent approval gates for governed agent runs and production deployment records.
- Docker Compose packaging, checksummed migrations, health checks, PostgreSQL integration tests, CI, and security documentation.

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
| `REQUIRE_SEPARATE_APPROVER` | `true` | Prevents users approving their own governed runs or deployments |
| `TRUST_PROXY` | `false` | Trust reverse-proxy forwarding headers |
| `EXECUTION_MODE` | `disabled` | `disabled`, `local`, or `docker` workspace verification |
| `ALLOW_PRIVATE_AI_ENDPOINTS` | `false` | Allows HTTP/private OpenAI-compatible endpoints |
| `DATA_DIR` | `.vibeable` | Project workspace storage |

`local` execution runs generated package scripts on the host and is only for a trusted developer machine. Shared installations should use a separately hardened Docker worker; see the threat model.

## Development commands

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

The detailed product and API design remains in [SPEC.md](SPEC.md). The current implementation and its boundaries are documented in [Architecture](docs/architecture.md), [Threat model](docs/threat-model.md), and [Production readiness](docs/production-readiness.md). Production dependency licenses are reproduced in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Community

Vibeable is dual-licensed for perpetual internal company use or noncommercial community use. Commercial redistribution and hosted-service use require a separate license. Read [LICENSE](LICENSE) and [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md) before use or distribution. Start contributions with [CONTRIBUTING.md](CONTRIBUTING.md), report vulnerabilities through [SECURITY.md](SECURITY.md), and follow the [Code of Conduct](CODE_OF_CONDUCT.md).
