# Contributing

Thank you for helping build Vibeable.

## Setup

Use Node.js 22+, pnpm 11, and PostgreSQL 15+. Copy `.env.example`, run `pnpm install`, `pnpm db:migrate`, and `pnpm dev`.

Before submitting a change, run:

```bash
pnpm check
git diff --check
```

Changes to permissions, tenant queries, provider networking, secret handling, workspace paths, or command execution must include focused tests and a threat-model update. Migrations are append-only after release; never edit an applied migration.

Keep pull requests narrowly scoped. Explain behavior changes, migration impact, security implications, and manual verification. Do not include generated workspaces, credentials, `.env` files, or customer data.

By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues belong in the private process described by [SECURITY.md](SECURITY.md), not a public issue.
