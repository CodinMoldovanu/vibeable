# Security audit

Audit date: 2026-07-21. Scope: commit `745088d` and the remediations applied immediately after it.

## Coverage

- Dependency advisories: pnpm audit, OSV-Scanner 2.4.0, and Trivy 0.72.0, including development dependencies.
- Secret history: Gitleaks 8.30.1 across every Git commit, plus Trivy filesystem secret scanning.
- Licenses: pnpm's complete production dependency graph and generated third-party notices.
- Container inputs: Trivy scans of the exact Node and PostgreSQL image tags used by Compose and the Dockerfile.
- Manual review: authentication, CSRF, RBAC, organization/team query boundaries, provider SSRF, encrypted resources, AI response parsing, generated file containment, Git subprocesses, preview isolation, build execution, and deployment adapters.

## Remediated findings

- High: patched `shell-quote` denial of service from the development dependency graph and changed CI to audit all dependencies.
- High: added a response-level CSP sandbox so generated preview JavaScript remains opaque even if a preview URL is opened directly.
- Medium: required the CSRF header for login, logout, and bootstrap, and reject browser mutations with a foreign `Origin`.
- Medium: expanded provider/webhook address denial to documentation, transition, benchmark, multicast, and other special-use IPv4/IPv6 ranges.
- Medium: removed bundled npm/corepack tooling from the final application image, pinned container image digests and GitHub Action commits, and enabled weekly dependency update pull requests.
- Low: prevented read-only project viewers from writing runtime logs that are later supplied to the coding model.
- Low: added connection, statement, transaction-idle, and lock limits to managed project database roles.

No committed credentials, prohibited production dependency licenses, SQL injection, cross-organization route bypass, generated-path escape, or dynamic deployment shell construction was found in this review.

## License review

- The 97 production packages use MIT, BSD-3-Clause, ISC, or BlueOak-1.0.0 terms. Their license texts are reproduced in `THIRD_PARTY_NOTICES.md`.
- Vibeable itself is source-available, not OSI open source. The included PolyForm Internal Use 1.0.0 and PolyForm Noncommercial 1.0.0 terms match the stated internal-company and noncommercial distribution policy.
- The current contribution terms license contributions under both included PolyForm licenses. They do not expressly assign copyright or grant a separate commercial relicensing right to the maintainer. Obtain legal advice and adopt a contributor agreement before promising commercial licenses that include third-party contributions.

This is an engineering compatibility review, not legal advice.

## Accepted residual risk

- `EXECUTION_MODE=local` runs untrusted generated build scripts with control-plane authority. It remains disabled by default and is unsupported on shared hosts.
- Docker and local deployment adapters inherit the authority of their worker, Docker endpoint, kubeconfig, and injected resources. Deployment execution remains disabled by default.
- Git validates DNS before invoking Git, but Git resolves the hostname again. Enforce outbound network policy for hostile tenants.
- Managed databases use separate PostgreSQL roles and schemas in the control database. This is suitable only for trusted evaluation, not hostile tenant isolation.
- Preview CSP sandboxing materially reduces same-origin impact, but a dedicated preview origin with capability tokens remains the production architecture.
- Budget checks do not reserve tokens across concurrent runs, and in-process queues require a single control-plane replica.
- The pinned PostgreSQL image contains scanner findings in the startup-only `gosu` binary's Go standard library. The affected TLS, URL, and mail parsing paths are not used by Vibeable; monitor the pinned image for an upstream rebuild.

Re-run this review before a stable release and obtain an independent penetration test before accepting untrusted users or high-value production workloads.
