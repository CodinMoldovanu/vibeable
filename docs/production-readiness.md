# Production readiness

Vibeable 0.1 is a community preview for trusted internal teams. It is not yet safe to market as a feature-complete or security-equivalent replacement for Lovable.

## Ready for

- A single organization on one control-plane replica.
- Trusted team members using OpenRouter or an approved OpenAI-compatible endpoint.
- Static web workspace generation and authenticated preview.
- Policy evaluation, prompt hooks, RBAC, usage reporting, and approval records.
- Evaluation behind TLS with PostgreSQL and durable workspace storage.

## Required before untrusted or high-value production use

- Extract orchestration to a durable queue with idempotent workers and run cancellation.
- Run every generated build and preview in a dedicated container/microVM worker without Docker socket access.
- Serve previews from a separate origin with short-lived capability tokens.
- Add outbound DNS/IP pinning and an egress proxy for provider requests.
- Add OIDC/SAML, MFA delegation, password reset, email invitations, and session management UI.
- Add repository import/export, remote push, side-by-side diffs, conflict handling, and explicit accept/reject review. Local branches and attributed commits are implemented.
- Add an actual deployment adapter and rollback implementation. Current deployment endpoints record approvals only.
- Reserve budget before concurrent calls and reconcile streamed/provider usage.
- Add secret rotation/versioning and integrate a production secret manager.
- Add broader browser end-to-end coverage, backup/restore drills, SLOs, and load tests. Disposable PostgreSQL API integration tests run in the standard test suite.
- Complete an independent security review.

## Release checklist

- `pnpm check` passes on the release commit.
- Database migrations are tested on a copy of production data and have a rollback plan.
- `NODE_ENV=production`, HTTPS, `COOKIE_SECURE=true`, and the exact `PUBLIC_URL` are configured.
- A unique random `MASTER_KEY` and database password are supplied through the host secret mechanism.
- `EXECUTION_MODE=disabled` unless a dedicated sandbox worker has been deployed and reviewed.
- PostgreSQL and workspace backups are encrypted, monitored, and restoration-tested.
- Logs and `/healthz` are monitored; audit retention matches company policy.

The roadmap in [SPEC.md](../SPEC.md) remains the source for the broader product, while this document describes the implemented release boundary.
