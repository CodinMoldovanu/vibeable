# Changelog

All notable changes to Vibeable will be documented here. The format follows Keep a Changelog and versioning follows Semantic Versioning after the first stable release.

## [Unreleased]

### Added

- PostgreSQL-backed community edition control plane.
- Organization bootstrap, sessions, teams, RBAC, projects, and audit records.
- OpenAI-compatible providers, scoped AI policies, prompt hooks, and budget enforcement.
- Structured coding runs, SSE event streaming, workspace previews, and usage metrics.
- Deployment approval records, Docker Compose packaging, CI, tests, and security documentation.
- Dual PolyForm licensing for perpetual internal company use and noncommercial community use.
- Git-backed run branches and commits, independent run approvals, selectable metric scopes, and PostgreSQL integration tests.
- Automatic run intent selection, provider/model dropdowns, editable provider endpoints, progressive run status, and resilient event refresh.
- Encrypted project resources, managed PostgreSQL schemas, preview/build logs, and one verification repair pass.

### Security

- Block model writes to repository metadata and secret-like files; disable Git hooks and ambient Git configuration for workspace operations.
- Prevent authenticated preview routes from serving repository metadata, dotfiles, and secret-like files, and mark preview responses private and non-cacheable.
- Pin AI provider connections to validated public DNS results, reject redirects and reflected provider credentials, and cover IPv4-mapped IPv6 private ranges.
- Scope deployment approval to accessible project teams and preserve stricter user budget/approval policy boundaries when user provider overrides are disabled.
- Refuse insecure non-loopback production `PUBLIC_URL` and cookie configuration at startup.
- Persist per-attempt usage, redact project secrets from runtime logs, clean up managed database roles transactionally, and checkpoint existing workspaces before new runs.
