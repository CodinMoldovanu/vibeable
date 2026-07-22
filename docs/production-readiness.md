# Production readiness

Vibeable 0.1 is a community preview for trusted internal teams. It is not yet safe to market as a feature-complete or security-equivalent replacement for Lovable.

Start with the [User guide](user-guide.md) to evaluate the implemented workflow and the [Operator guide](operator-guide.md) to deploy, back up, restore, and monitor it. This page defines the boundary those guides must not be read beyond.

## Ready for

- A single organization on one control-plane replica.
- Trusted team members using OpenRouter or an approved OpenAI-compatible endpoint.
- Static web workspace generation and authenticated preview.
- Editable policy-approved AI endpoints, automatic intent routing, progressive run feedback, captured preview logs, and one verification repair pass.
- Encrypted build-time resources and project-isolated PostgreSQL roles/schemas for trusted evaluation.
- Policy evaluation, prompt hooks, RBAC, usage reporting, and approval records.
- Enforced stack profiles, HTTPS Git synchronization, branch workers, archive/offload/restore, and exact-commit deployment plans.
- Allowlisted local deployment adapters with independent production approval, bounded logs, selected resource injection, health checks, and rollback planning.
- Evaluation behind TLS with PostgreSQL and durable workspace storage.

## Required before untrusted or high-value production use

- Extract orchestration to a durable queue with idempotent workers and run cancellation.
- Run every generated build and preview in a dedicated container/microVM worker without Docker socket access.
- Serve previews from a separate origin with short-lived capability tokens.
- Add an outbound egress proxy or network policy for provider requests. DNS/IP validation and connection pinning are implemented in-process.
- Add SAML, password reset, email invitations, and session management UI. OIDC authorization-code login delegates MFA to the configured identity provider.
- Add side-by-side diffs, conflict-resolution UI, explicit accept/reject review, Git host application credentials, and protected-branch status integration. HTTPS remote pull/push and encrypted bearer/basic credentials are implemented.
- Add a dedicated generated-application runtime worker before claiming backend, SMTP, API, or managed-database resources are available to deployed applications. Current values are build-verifier inputs and static previews receive no secrets.
- Extract deployment execution into dedicated durable workers. Local adapters currently execute allowlisted binaries from the control-plane host; default container images intentionally do not include cluster credentials, a Docker socket, or deployment CLIs.
- Reserve budget before concurrent calls and reconcile streamed/provider usage.
- Add secret rotation/versioning and integrate a production secret manager.
- Add broader browser end-to-end coverage, backup/restore drills, SLOs, and load tests. Disposable PostgreSQL API integration tests run in the standard test suite.
- Complete an independent security review.

The in-repository audit in [Security audit](security-audit.md) records automated scanner coverage, remediations, and accepted residual risks. It is a point-in-time review, not an independent penetration test.

## Release checklist

- `pnpm check` passes on the release commit.
- Database migrations are tested on a copy of production data and have a rollback plan.
- `NODE_ENV=production`, HTTPS, `COOKIE_SECURE=true`, and the exact `PUBLIC_URL` are configured.
- A unique random `MASTER_KEY` and database password are supplied through the host secret mechanism.
- `EXECUTION_MODE=disabled` unless a dedicated sandbox worker has been deployed and reviewed.
- `DEPLOYMENT_EXECUTION_MODE=disabled` unless adapter binaries, credentials, egress, and isolation have been reviewed. Prefer a signed webhook to a separate deployment controller.
- PostgreSQL and workspace backups are encrypted, monitored, and restoration-tested.
- Logs and `/healthz` are monitored; audit retention matches company policy.

The roadmap in [SPEC.md](../SPEC.md) remains the source for the broader product, while this document describes the implemented release boundary.
