# User guide

This guide describes the implemented Vibeable workflow for a trusted internal organization. It starts after an operator has deployed the service. See the [Operator guide](operator-guide.md) for installation and maintenance.

## Mental model

A Vibeable project has four related but distinct parts:

1. **Workspace:** files on durable server storage, initialized as a Git repository.
2. **Control-plane record:** team ownership, policies, run history, usage, resources, Git settings, and deployments stored in PostgreSQL.
3. **Preview:** an authenticated, sandboxed view of public workspace files. It does not receive secret values and is not a backend hosting environment.
4. **Remote Git repository:** an optional long-term source of truth for source branches. It does not replace the PostgreSQL backup.

A successful build records an exact Git commit, creates an attributed agent commit when files changed, fast-forwards the selected target branch, and refreshes the preview. If remote Git is configured, direct runs are pushed automatically; a branch worker is pushed when its **Auto-push** option is enabled.

## Roles

Roles apply at organization membership level. Team membership controls which team projects a non-administrator can access.

| Role | Typical use | Important permissions |
| --- | --- | --- |
| Owner | Service owner and break-glass administrator | Full organization management, global metrics, purge, policy, secrets, approvals, and audit |
| Admin | Platform or engineering administrator | Teams, projects, policies, secrets, approvals, team/user/project metrics, and audit |
| Developer | Product builder | Create/update projects, run the agent, create deployment plans, and view own/project usage |
| Reviewer | Independent reviewer | Read projects, approve governed agent changes and deployments, and view team/project usage |
| Viewer | Stakeholder | Read accessible projects and previews |

With `REQUIRE_SEPARATE_APPROVER=true`, a user cannot approve their own governed run or production deployment. Keep at least two appropriately authorized users if approvals are enabled.

## Bootstrap the organization

On an empty database, the first browser is shown the bootstrap form. Create:

- The organization and owner account.
- The initial team.
- The first OpenAI-compatible provider, endpoint, model, and API key.
- The initial global AI policy and monthly limits.

Provider keys are encrypted server-side and are never returned to the browser after submission. Keep the same `MASTER_KEY` for the life of the installation; losing it makes encrypted provider, project, and Git credentials unreadable.

For company SSO, finish bootstrap with a local owner first, then follow [OIDC setup](oidc.md). Keep one tested local owner account as a recovery path.

## Configure teams and access

Owners and admins use **Teams & users** to create teams. Owners additionally create local users, assign organization roles, and place users into teams. The current UI does not provide password-reset or email-invitation workflows; use OIDC for normal company account lifecycle where possible.

A practical structure is:

- One team per product group or platform boundary.
- Developers for people creating changes.
- Reviewers for people who approve sensitive agent phases or production deployments.
- Admins limited to the platform group that owns providers, stack policy, deployment profiles, and secrets.

OIDC can create users and synchronize only memberships that originated from OIDC claims. Locally managed roles and memberships are not silently removed by claim synchronization.

## Configure AI governance

Use **AI governance** for providers, policies, and prompt hooks.

### Providers and models

Each provider requires:

- A name shown to builders.
- A base URL exposing an OpenAI-compatible `/chat/completions` API.
- An optional API key.
- An exact default model identifier and list of allowed model identifiers.
- Input and output prices per million tokens for estimated-cost reporting.

Vibeable does not currently discover a provider's model catalog. Administrators enter exact model IDs and update prices when the provider changes them. The default model is shown as **Recommended**; builders may choose only models left by effective policy.

Public endpoints must use HTTPS and resolve to public addresses. Set `ALLOW_PRIVATE_AI_ENDPOINTS=true` only when an operator intentionally allows internal or HTTP endpoints and has reviewed the egress boundary.

### Scoped policies

Policies can apply globally or to a team, user, or project. Effective policy is resolved from broad to narrow scopes:

- Allowed provider and model sets are intersected.
- The strictest token and cost limits win.
- A more specific default can be selected only from the surviving allowed set.
- Approval requirements accumulate.
- Missing global policy or an empty provider/model intersection fails closed.

Use the global policy for company-wide boundaries, team policy for different product groups, project policy for a sensitive application, and user policy for an exceptional individual restriction. Cost values are estimates based on configured prices, not a reconciliation with the provider invoice.

### Prompt hooks

Prompt hooks inject organization or team instructions at lifecycle phases such as planning, editing, verification failure, deployment preparation, database migration, or production preparation. Higher priority hooks are applied first; mandatory hooks cannot be removed by a narrower scope.

These phases guide agent runs. Executing a previously recorded deployment plan does not make a new model call or reinterpret its adapter configuration.

Good hooks state verifiable requirements, for example:

- "Use the shared design-system package and preserve keyboard navigation."
- "Prepare Helm values for the internal ingress class and emit a readiness endpoint."
- "For production changes, include a migration rollback note."

Do not place credentials in hooks. Use project resources for values and mention only their resource names.

## Enforce technology and delivery choices

Owners and admins use **Stacks & delivery**.

### Technology profiles

A technology profile may be global, team-scoped, or project-scoped and can enforce:

- Allowed languages and recognized frameworks.
- Allowed package managers.
- Allowed Docker base-image names.
- Required files, dependencies, and package scripts.
- Forbidden dependencies.

The effective profile is included in the agent context and checked after editing. A failing stack check triggers the same single repair opportunity as a failing workspace build. Detection is intentionally bounded: framework checks currently recognize React, Vue, Svelte, Next.js, Express, Fastify, NestJS, and Hono from `package.json`.

### Deployment profiles

Deployment profiles are scoped to a team or project and target `staging` or `production`.

| Adapter | Required configuration | Execution behavior |
| --- | --- | --- |
| Kubernetes | `manifestPath`; optional `context`, `namespace`, `rolloutResource` | Applies the manifest and can wait for rollout |
| Helm | `chartPath`, `release`, `namespace`; optional `valuesPath`, `context` | Runs an allowlisted Helm upgrade/install command |
| Docker Swarm | `composePath`, `stack` | Runs Docker stack deployment |
| Compose | `composePath`; optional `projectName` | Runs Docker Compose against the recorded workspace |
| GitOps | Optional destination `branch` | Pushes the exact recorded commit to project Git |
| Webhook | `url`; optional `authResource` | Sends project, environment, branch, and commit metadata to a deployment controller |

Every adapter also accepts optional `healthUrl` and `expectedStatus`. Paths must be relative workspace paths. Profiles list the exact project resource names that may be injected during execution.

Creating a profile does not enable deployment commands. `DEPLOYMENT_EXECUTION_MODE` is disabled by default. Prefer GitOps or a constrained webhook to an independently secured deployment controller; see [Production readiness](production-readiness.md).

## Create the first governed project

1. Select **Create project** in the sidebar and choose its team.
2. If required, open **Git** and select an available technology profile.
3. In **Build context**, choose the provider, recommended or approved model, target branch, and optional worker.
4. Describe the desired outcome, interactions, constraints, and acceptance criteria. Do not paste credentials.
5. Select **Start build** and watch the persisted planning, editing, verification, and completion events.
6. Inspect the live preview and use the desktop, tablet, and mobile controls.
7. Review **Files** for changed-file summaries and **Logs** for build and preview output.
8. Iterate with a focused follow-up request. Recent redacted logs and bounded workspace context are supplied to the next run automatically.

The agent chooses the lifecycle intent from the request; builders do not manually select a phase. Policy may place a run into **waiting approval** before work proceeds.

### What verification means

| `EXECUTION_MODE` | Behavior |
| --- | --- |
| `disabled` | Performs file/path safety and stack-profile checks, but does not install dependencies or run a build |
| `local` | Runs the generated package install/build on the control-plane host; only for a trusted single-user machine |
| `docker` | Runs package install/build in a constrained, network-disabled Node container; requires reviewed Docker access |

For a workspace with `package.json`, executable verification currently runs a frozen pnpm install with scripts disabled and then `pnpm run build`. A static workspace without `package.json` is treated as ready. This is build verification, not a persistent generated-application runtime.

## Add APIs, SMTP, secrets, and databases

Use the project's **Resources** tab to register capabilities:

- `secret`: an arbitrary environment variable.
- `api`: an API credential plus non-secret URL metadata.
- `smtp`: SMTP credential and endpoint metadata.
- `service`: a service URL or other non-secret connection metadata, optionally with a value.
- `git`: credential-free HTTPS repository metadata for generated application use.
- `database`: a managed development `DATABASE_URL` provisioned by Vibeable.

Resource names use environment-variable format such as `PAYMENTS_API_KEY` or `SMTP_PASSWORD`. Values are write-only after submission. The agent receives the name, type, environment, configuration metadata, and whether a value exists, but never the value itself.

Values matching the run environment or `all` are injected into executable verification. Deployment receives only resource names explicitly selected by the deployment profile. Static previews receive no values. API and service URL metadata expands preview CSP connectivity, but the browser still needs an API designed for browser access.

Managed databases create a project-specific PostgreSQL role and schema in the configured control database. This is convenient for trusted evaluation, not isolation between hostile tenants, and a generated backend still needs an external runtime in which to use the connection.

## Keep a long-lived project in Git

Use the project's **Git** tab to configure a credential-free HTTPS repository URL. SSH-style `git@host:path` remotes are not supported. Credentials may be:

- A bearer token sent as an HTTP authorization header.
- `username:token` stored as a Basic authorization credential.

Leave the credential field blank on later edits to retain the encrypted value.

### Attach a remote

The reliable first-time flow is:

1. Create the Vibeable project, which initializes its own `main` history.
2. Create an empty remote repository.
3. Configure its HTTPS URL, default branch, credentials, and sync mode.
4. Select **Push** or complete a successful direct run to publish the project.
5. Continue iterating from Vibeable or another Git client without rewriting the shared history.

**Pull** uses fetch plus fast-forward-only merge and is intended for remote branches descended from the local Vibeable history. The current UI does not provide a general import/replace workflow for an unrelated existing repository and does not resolve conflicts. Do not connect a non-empty unrelated remote expecting Vibeable to overwrite or merge it. Resolve related-history divergence in a normal Git client, then pull again.

### Push behavior

- Every successful run uses a run-specific agent branch and records an exact resulting commit; commits created for changed files include run, user, provider, model, and token attribution.
- The commit is fast-forwarded into the selected target branch.
- `mirror` sync pushes the target branch and run branch.
- `source` sync pushes only the target branch.
- Direct runs auto-push when Git is enabled.
- Worker runs auto-push only when that worker has **Auto-push** enabled.
- A push failure does not discard a successful local build; the event stream records the failure for manual retry.

### Branch workers

A branch worker is a persistent logical build lane, not an autonomous daemon. Give it a name, base branch, working branch, and auto-push choice. Select that worker in **Build context** to route runs to its branch. Use **Promote branch** to merge it into the destination branch with a merge commit and optionally push the destination.

This supports a practical flow such as `main`, `feature/new-checkout`, and `experiment/new-model` without mixing agent runs.

Promotion can fail when branches conflict. There is no conflict-resolution UI; resolve the branches in a standard Git client and synchronize the result.

## Deploy an exact commit

1. An administrator creates a team or project deployment profile.
2. A developer opens **Deploy**, selects the profile and branch, and creates a deployment.
3. Vibeable records the exact commit, adapter configuration, selected resource names, referenced paths, and health check as an immutable plan.
4. Production plans wait for a different owner, admin, or reviewer when separate approval is enabled.
5. An authorized user executes the plan if the operator enabled deployment execution.
6. Vibeable uses a detached worktree at the recorded commit, injects only selected resources, records bounded redacted output, and runs the optional health check.
7. Rollback creates a new governed deployment targeting the prior successful commit; it does not mutate the old record.

Vibeable does not create cluster credentials or install deployment CLIs. The operator is responsible for the worker environment and should avoid placing that authority in the web control plane.

## Read usage metrics

Open **Usage** or the project **Metrics** tab and select a scope allowed by your role:

- Global organization usage.
- A team.
- A user.
- A project.

Metrics include input, output, and total tokens, request count, model grouping, and estimated cost. Provider attempts are counted even when verification later fails. Monthly policy limits are checked before calls, but concurrent requests can race the cap because reservations are not implemented yet.

## Archive, offload, trash, and restore

- **Archive** keeps the workspace but prevents builds and deployments until restore.
- **Offload to Git** first pushes according to sync mode, then removes local workspace files. Git must be configured.
- **Restore** reactivates an archive or clones the active branch for an offloaded project.
- **Move to trash** is reversible and prevents work.
- **Purge permanently** is owner-only, requires trash first, and removes the workspace, managed resources, and project database records.

Offload is a workspace-capacity feature, not a complete backup. Keep PostgreSQL backups for policies, history, resource metadata, encrypted values, Git settings, and lifecycle state.

## Common failure states

| Message or state | Meaning and response |
| --- | --- |
| Empty provider/model options | Effective policy has no allowed intersection or the provider is disabled; fix the applicable policies |
| Waiting approval | Another authorized user must approve the governed phase |
| Provider timeout/error | Verify endpoint, key, exact model ID, provider status, and outbound egress |
| Verification failed after repair | Review **Logs**, stack-profile violations, lockfile, and build scripts; issue a focused repair request |
| Git push failed | Local commit remains; verify HTTPS URL/token/branch permission and use **Push** again |
| Pull cannot fast-forward | Resolve divergence in a normal Git client, then retry |
| Deployment execution disabled | The plan is valid, but the operator has not enabled a reviewed execution worker |
| Preview works but backend features do not | The preview is static and receives no secrets; deploy the backend to an application runtime |

## Security boundary

Generated code, model output, repository content, and captured logs are untrusted. Do not enable host execution for untrusted users. Before broader production use, read the [Threat model](threat-model.md) and [Production readiness](production-readiness.md).
