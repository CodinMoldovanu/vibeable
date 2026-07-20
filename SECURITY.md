# Security policy

## Supported versions

Until the first stable release, security fixes are made on the latest `main` branch only.

## Reporting a vulnerability

Do not open a public issue. Use GitHub private vulnerability reporting after the repository is published, or contact the maintainer through the private address listed in the repository security settings. Include affected versions, prerequisites, reproduction steps, impact, and any suggested mitigation.

You should receive acknowledgement within three business days and an initial assessment within seven. Please allow a reasonable remediation window before public disclosure.

## Scope notes

Generated code and model output are untrusted input. `EXECUTION_MODE=local` is explicitly outside the supported shared-host security boundary. See [docs/threat-model.md](docs/threat-model.md) before deployment.
