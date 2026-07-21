import { extname, join } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { hash } from "bcryptjs";
import Fastify, { type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import type { AgentPhase, Permission, Role, ScopeType } from "../src/domain/types.js";
import { can } from "../src/domain/rbac.js";
import { inferAgentPhase } from "../src/domain/intent.js";
import { authenticate, createSession, destroySession, getPrincipal, requirePrincipal } from "./auth.js";
import { config } from "./config.js";
import { registerDeliveryRoutes } from "./delivery-routes.js";
import { pool, query, transaction } from "./db.js";
import { subscribeToRun } from "./events.js";
import { enqueueRun, recordRunEvent } from "./orchestrator.js";
import { requirePermission } from "./permissions.js";
import { resolvePolicy } from "./policy.js";
import { assertGitBranch } from "./project-git.js";
import { assertSafeProviderUrl, encryptSecret } from "./security.js";
import {
  deleteProjectResource, listProjectResources, projectPreviewOrigins, provisionProjectDatabase, recordProjectLog,
  upsertProjectResource, type ResourceKind
} from "./resources.js";
import { assertProjectOperational, getAccessibleProject, listMemberTeamIds, writeAudit } from "./store.js";
import { ensureWorkspace, readPreview } from "./workspace.js";

const idSchema = z.string().uuid();
const phaseSchema = z.enum([
  "project:create", "agent:before_plan", "agent:before_edit", "agent:after_edit", "agent:after_error",
  "agent:before_test", "agent:after_test_failure", "deploy:prepare", "deploy:preflight",
  "deploy:post_success", "deploy:post_failure", "summarize_logs", "classify_error",
  "generate_commit_message", "database_migration", "production_deploy_prepare"
]);
const scopeSchema = z.enum(["global", "team", "user", "project"]);
const resourceConfigSchema = z.record(
  z.string().trim().min(1).max(64),
  z.union([z.string().trim().max(2000), z.number().finite(), z.boolean()])
).superRefine((value, context) => {
  if (Object.keys(value).length > 20) context.addIssue({ code: "custom", message: "Resource metadata is limited to 20 fields" });
});

export function buildApp() {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie", "body.password", "body.apiKey"] },
    trustProxy: config.trustProxy,
    bodyLimit: 1_100_000,
    requestTimeout: 30_000
  });

  void app.register(fastifyCookie);
  void app.register(fastifyCors, { origin: config.PUBLIC_URL, credentials: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] });
  void app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    }
  });
  void app.register(fastifyRateLimit, { max: 300, timeWindow: "1 minute" });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (request.headers["x-vibeable-csrf"] !== "1") return reply.code(403).send({ error: "Missing CSRF header" });
      const origin = request.headers.origin;
      if (origin && origin !== new URL(config.PUBLIC_URL).origin) {
        return reply.code(403).send({ error: "Request origin is not allowed" });
      }
    }
  });

  app.get("/healthz", async (_request, reply) => {
    try {
      await query("SELECT 1");
      return { status: "ok", database: "ok", executionMode: config.EXECUTION_MODE, deploymentExecutionMode: config.DEPLOYMENT_EXECUTION_MODE };
    } catch {
      return reply.code(503).send({ status: "error", database: "unavailable" });
    }
  });

  app.get("/api/auth/setup-status", async () => {
    const result = await query<{ count: string }>("SELECT count(*)::text AS count FROM users");
    return { needsBootstrap: Number(result.rows[0]?.count ?? 0) === 0 };
  });

  app.post("/api/auth/bootstrap", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (request, reply) => {
    const input = z.object({
      organizationName: z.string().trim().min(2).max(100),
      name: z.string().trim().min(2).max(100),
      email: z.string().email().max(254),
      password: z.string().min(12).max(200),
      providerName: z.string().trim().min(2).max(100).default("OpenRouter"),
      providerUrl: z.string().url().default("https://openrouter.ai/api/v1"),
      providerModel: z.string().trim().min(1).max(200).default("openai/gpt-5-mini"),
      apiKey: z.string().max(1000).optional()
    }).parse(request.body);
    const passwordHash = await hash(input.password, 12);
    const baseUrl = assertSafeProviderUrl(input.providerUrl);
    const userId = await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('vibeable:bootstrap'))");
      const existing = await client.query("SELECT 1 FROM users LIMIT 1");
      if (existing.rowCount) throw Object.assign(new Error("Instance is already bootstrapped"), { statusCode: 409 });
      const org = await client.query<{ id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        [input.organizationName, slugify(input.organizationName)]
      );
      const organizationId = org.rows[0]!.id;
      const user = await client.query<{ id: string }>(
        "INSERT INTO users (email, name, password_hash) VALUES (lower($1), $2, $3) RETURNING id",
        [input.email, input.name, passwordHash]
      );
      const ownerId = user.rows[0]!.id;
      const team = await client.query<{ id: string }>(
        "INSERT INTO teams (organization_id, name, slug) VALUES ($1, 'Default', 'default') RETURNING id",
        [organizationId]
      );
      await client.query(
        "INSERT INTO memberships (organization_id, team_id, user_id, role) VALUES ($1, NULL, $2, 'owner'), ($1, $3, $2, 'owner')",
        [organizationId, ownerId, team.rows[0]!.id]
      );
      const provider = await client.query<{ id: string }>(
        `INSERT INTO ai_providers
          (organization_id, name, base_url, encrypted_api_key, default_model, allowed_models)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [organizationId, input.providerName, baseUrl, input.apiKey ? encryptSecret(input.apiKey) : null,
          input.providerModel, JSON.stringify([input.providerModel])]
      );
      await client.query(
        `INSERT INTO ai_policies
          (organization_id, scope_type, scope_id, default_provider_id, default_model, allowed_provider_ids,
           allowed_models, monthly_token_limit, monthly_cost_limit_usd, allow_user_override)
         VALUES ($1, 'global', $1, $2, $3, $4, $5, 10000000, 500, true)`,
        [organizationId, provider.rows[0]!.id, input.providerModel, JSON.stringify([provider.rows[0]!.id]), JSON.stringify([input.providerModel])]
      );
      await client.query(
        `INSERT INTO prompt_hooks (organization_id, scope_type, scope_id, phase, priority, mandatory, title, prompt)
         VALUES ($1, 'global', $1, 'deploy:prepare', 100, true, 'Production readiness',
         'Before deployment, run tests and builds, provide a health endpoint, use runtime-injected secrets, and make migrations reversible.')`,
        [organizationId]
      );
      return ownerId;
    });
    await createSession(userId, reply);
    return reply.code(201).send({ ok: true });
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const input = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).parse(request.body);
    const userId = await authenticate(input.email, input.password);
    if (!userId) return reply.code(401).send({ error: "Invalid email or password" });
    await createSession(userId, reply);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await destroySession(request, reply);
    return { ok: true };
  });

  app.get("/api/session", async (request, reply) => {
    const principal = await getPrincipal(request);
    if (!principal) return reply.code(401).send({ error: "Authentication required" });
    const teams = await query<{ id: string; name: string; role: Role }>(
      `SELECT t.id, t.name, m.role FROM memberships m JOIN teams t ON t.id = m.team_id
        WHERE m.user_id = $1 AND m.organization_id = $2`,
      [principal.userId, principal.organizationId]
    );
    return { user: principal, teams: teams.rows };
  });

  app.get("/api/projects", async (request) => {
    const principal = await requirePrincipal(request);
    const { lifecycle } = z.object({ lifecycle: z.enum(["active", "archived", "trash", "all"]).default("active") }).parse(request.query);
    const allTeams = ["owner", "admin"].includes(principal.role);
    const lifecycleFilter = lifecycle === "active"
      ? "p.archived_at IS NULL AND p.deleted_at IS NULL"
      : lifecycle === "archived"
        ? "p.archived_at IS NOT NULL AND p.deleted_at IS NULL"
        : lifecycle === "trash" ? "p.deleted_at IS NOT NULL" : "true";
    const result = await query(
      `SELECT p.id, p.name, p.slug, p.status, p.environment, p.team_id AS "teamId", t.name AS "teamName",
              p.active_branch AS "activeBranch", p.archived_at AS "archivedAt", p.deleted_at AS "deletedAt",
              p.offloaded_at AS "offloadedAt", p.updated_at AS "updatedAt",
              '/api/projects/' || p.id || '/preview/' AS "previewUrl"
         FROM projects p JOIN teams t ON t.id = p.team_id
        WHERE p.organization_id = $1 AND ($2::boolean OR EXISTS (
          SELECT 1 FROM memberships m WHERE m.user_id = $3 AND m.team_id = p.team_id))
          AND ${lifecycleFilter}
        ORDER BY p.updated_at DESC`,
      [principal.organizationId, allTeams, principal.userId]
    );
    return { projects: result.rows };
  });

  app.post("/api/projects", async (request, reply) => {
    const principal = await requirePrincipal(request);
    requirePermission(principal, "project:create");
    const input = z.object({ name: z.string().trim().min(2).max(100), teamId: idSchema }).parse(request.body);
    const teamIds = await listMemberTeamIds(principal);
    if (!["owner", "admin"].includes(principal.role) && !teamIds.includes(input.teamId)) return reply.code(403).send({ error: "Team access denied" });
    const result = await query<{ id: string }>(
      `INSERT INTO projects (organization_id, team_id, owner_id, name, slug, status)
       SELECT $1, id, $2, $3, $4, 'draft' FROM teams WHERE id = $5 AND organization_id = $1 RETURNING id`,
      [principal.organizationId, principal.userId, input.name, `${slugify(input.name)}-${Date.now().toString(36)}`, input.teamId]
    );
    const project = result.rows[0];
    if (!project) return reply.code(404).send({ error: "Team not found" });
    await ensureWorkspace(project.id, input.name);
    await writeAudit(principal, "project.created", "project", project.id, { name: input.name, teamId: input.teamId }, request.ip);
    return reply.code(201).send({ id: project.id });
  });

  app.get("/api/projects/:projectId/runs", async (request) => {
    const principal = await requirePrincipal(request);
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    await getAccessibleProject(principal, projectId);
    const result = await query(
      `SELECT r.id, r.phase, r.prompt, r.status, r.model, r.provider_id AS "providerId",
              r.progress, r.stage_message AS "stageMessage", r.repair_attempts AS "repairAttempts",
              r.commit_sha AS "commitSha", r.total_tokens AS "totalTokens",
              r.user_id AS "userId", r.target_branch AS "targetBranch", r.worker_id AS "workerId",
              r.estimated_cost_usd::float8 AS "estimatedCostUsd", r.created_at AS "createdAt", r.finished_at AS "finishedAt",
              coalesce((SELECT json_agg(json_build_object('sequence', e.sequence, 'type', e.type, 'message', e.message, 'metadata', e.metadata, 'createdAt', e.created_at) ORDER BY e.sequence)
                FROM agent_run_events e WHERE e.run_id = r.id), '[]') AS events,
              coalesce((SELECT json_agg(json_build_object('path', f.path, 'additions', f.additions, 'deletions', f.deletions, 'summary', f.summary))
                FROM agent_run_files f WHERE f.run_id = r.id), '[]') AS files
         FROM agent_runs r WHERE r.project_id = $1 ORDER BY r.created_at DESC LIMIT 30`,
      [projectId]
    );
    return { runs: result.rows };
  });

  app.post("/api/projects/:projectId/runs", async (request, reply) => {
    const principal = await requirePrincipal(request);
    requirePermission(principal, "agent:run");
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const input = z.object({
      prompt: z.string().trim().min(3).max(50_000),
      providerId: idSchema.optional(),
      model: z.string().trim().min(1).max(200).optional(),
      phase: phaseSchema.optional(),
      targetBranch: z.string().trim().min(1).max(200).optional(),
      workerId: idSchema.optional()
    }).parse(request.body);
    const project = await getAccessibleProject(principal, projectId);
    assertProjectOperational(project);
    let targetBranch = input.targetBranch ?? project.activeBranch;
    if (input.workerId) {
      const worker = await query<{ workingBranch: string }>(
        `SELECT working_branch AS "workingBranch" FROM project_workers
          WHERE id=$1 AND organization_id=$2 AND project_id=$3 AND status='active'`,
        [input.workerId, principal.organizationId, project.id]
      );
      if (!worker.rows[0]) return reply.code(400).send({ error: "Worker is not active for this project" });
      targetBranch = worker.rows[0].workingBranch;
    }
    assertGitBranch(targetBranch);
    const completed = await query("SELECT 1 FROM agent_runs WHERE project_id=$1 AND status='ready' LIMIT 1", [project.id]);
    const phase = input.phase ?? inferAgentPhase(input.prompt, Boolean(completed.rowCount));
    const policy = await resolvePolicy({
      organizationId: principal.organizationId,
      teamId: project.teamId,
      userId: principal.userId,
      projectId: project.id,
      phase,
      providerId: input.providerId,
      model: input.model
    });
    const status = policy.requireApproval ? "waiting_approval" : "queued";
    const result = await query<{ id: string }>(
      `INSERT INTO agent_runs
        (organization_id, team_id, project_id, user_id, phase, prompt, status, provider_id, model, target_branch, worker_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [principal.organizationId, project.teamId, project.id, principal.userId, phase, input.prompt,
        status, policy.provider.id, policy.model, targetBranch, input.workerId ?? null]
    );
    const run = result.rows[0]!;
    await query("UPDATE projects SET status = 'building', updated_at = now() WHERE id = $1", [project.id]);
    await writeAudit(principal, "agent_run.created", "agent_run", run.id, {
      projectId: project.id, phase, providerId: policy.provider.id, model: policy.model, status, targetBranch,
      workerId: input.workerId ?? null
    }, request.ip);
    if (status === "waiting_approval") {
      await recordRunEvent(run.id, "approval", "Run is waiting for an authorized approver");
    } else {
      enqueueRun(run.id);
    }
    return reply.code(202).send({ id: run.id, status });
  });

  app.get("/api/projects/:projectId/provider-options", async (request) => {
    const principal = await requirePrincipal(request);
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const project = await getAccessibleProject(principal, projectId);
    const policy = await resolvePolicy({
      organizationId: principal.organizationId, teamId: project.teamId, userId: principal.userId,
      projectId: project.id, phase: "agent:before_edit"
    });
    return {
      selected: { providerId: policy.provider.id, model: policy.model },
      providers: policy.providerOptions
    };
  });

  app.post("/api/runs/:runId/approve", async (request, reply) => {
    const principal = await requirePrincipal(request);
    requirePermission(principal, "agent:approve_changes");
    const { runId } = z.object({ runId: idSchema }).parse(request.params);
    const existing = await query<{ project_id: string }>("SELECT project_id FROM agent_runs WHERE id = $1 AND organization_id = $2", [runId, principal.organizationId]);
    if (!existing.rows[0]) return reply.code(404).send({ error: "Run not found" });
    await getAccessibleProject(principal, existing.rows[0].project_id);
    const result = await query<{ id: string }>(
      `UPDATE agent_runs SET status='queued', approved_by=$2, approved_at=now()
        WHERE id=$1 AND organization_id=$3 AND status='waiting_approval'
          AND ($4::boolean = false OR user_id <> $2) RETURNING id`,
      [runId, principal.userId, principal.organizationId, config.requireSeparateApprover]
    );
    if (!result.rows[0]) throw Object.assign(new Error("Run is not awaiting approval or requires a different approver"), { statusCode: 409 });
    await recordRunEvent(runId, "approval", `Approved by ${principal.name}`);
    await writeAudit(principal, "agent_run.approved", "agent_run", runId, {}, request.ip);
    enqueueRun(runId);
    return { ok: true };
  });

  app.get("/api/runs/:runId/events", async (request, reply) => {
    const principal = await requirePrincipal(request);
    const { runId } = z.object({ runId: idSchema }).parse(request.params);
    const run = await query<{ project_id: string }>("SELECT project_id FROM agent_runs WHERE id = $1", [runId]);
    if (!run.rows[0]) return reply.code(404).send({ error: "Run not found" });
    await getAccessibleProject(principal, run.rows[0].project_id);
    const existing = await query(
      `SELECT id, run_id AS "runId", sequence, type, message, metadata, created_at AS "createdAt"
         FROM agent_run_events WHERE run_id = $1 ORDER BY sequence`,
      [runId]
    );
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    for (const event of existing.rows) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = subscribeToRun(runId, (event) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`));
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    request.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  });

  app.get("/api/projects/:projectId/policy", async (request) => {
    const principal = await requirePrincipal(request);
    const params = z.object({ projectId: idSchema }).parse(request.params);
    const queryInput = z.object({ phase: phaseSchema.default("agent:before_edit") }).parse(request.query);
    const project = await getAccessibleProject(principal, params.projectId);
    const policy = await resolvePolicy({
      organizationId: principal.organizationId, teamId: project.teamId, userId: principal.userId,
      projectId: project.id, phase: queryInput.phase
    });
    return { policy: { ...policy, encryptedApiKey: undefined } };
  });

  registerAdminRoutes(app);
  registerMetricsRoutes(app);
  registerDeliveryRoutes(app);
  registerProjectResourceRoutes(app);

  app.get("/api/projects/:projectId/preview/*", async (request, reply) => {
    const principal = await requirePrincipal(request);
    const params = z.object({ projectId: idSchema, "*": z.string().default("") }).parse(request.params);
    const project = await getAccessibleProject(principal, params.projectId);
    assertProjectOperational(project);
    const path = params["*"] || "index.html";
    const content = await readPreview(params.projectId, path);
    const previewOrigins = await projectPreviewOrigins(principal.organizationId, params.projectId);
    const body = extname(path).toLowerCase() === ".html"
      ? injectPreviewBridge(content.toString("utf8"), params.projectId)
      : content;
    return reply.type(mimeType(path))
      .header("cache-control", "private, no-store")
      .header("content-security-policy", `sandbox allow-scripts allow-forms allow-modals; default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: ${previewOrigins.join(" ")}; connect-src 'self' ${previewOrigins.join(" ")}; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`)
      .send(body);
  });

  app.setErrorHandler((error, request, reply) => {
    const databaseCode = (error as Error & { code?: string }).code;
    const statusCode = error instanceof ZodError ? 400
      : databaseCode === "23505" ? 409
        : Number((error as Error & { statusCode?: number }).statusCode ?? 500);
    if (statusCode >= 500) request.log.error(error);
    const message = statusCode >= 500 && config.NODE_ENV === "production"
      ? "Internal server error"
      : error instanceof Error ? error.message : "Request failed";
    reply.code(statusCode).send({ error: message, details: error instanceof ZodError ? error.issues : undefined });
  });

  if (config.NODE_ENV === "production") {
    const root = join(process.cwd(), "dist");
    void app.register(fastifyStatic, { root, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url === "/healthz") return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}

function registerAdminRoutes(app: FastifyInstance) {
  app.get("/api/admin/teams", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "team:update");
    const result = await query(
      `SELECT t.id, t.name, t.slug, count(m.user_id)::int AS "memberCount"
         FROM teams t LEFT JOIN memberships m ON m.team_id = t.id
        WHERE t.organization_id = $1 GROUP BY t.id ORDER BY t.name`,
      [principal.organizationId]
    );
    return { teams: result.rows };
  });
  app.post("/api/admin/teams", async (request, reply) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "team:update");
    const input = z.object({ name: z.string().trim().min(2).max(100) }).parse(request.body);
    const result = await query<{ id: string }>(
      "INSERT INTO teams (organization_id, name, slug) VALUES ($1,$2,$3) RETURNING id",
      [principal.organizationId, input.name, `${slugify(input.name)}-${Date.now().toString(36)}`]
    );
    await writeAudit(principal, "team.created", "team", result.rows[0]!.id, { name: input.name }, request.ip);
    return reply.code(201).send({ id: result.rows[0]!.id });
  });
  app.get("/api/admin/users", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "org:manage");
    const result = await query(
      `SELECT u.id, u.email, u.name, om.role,
              coalesce(json_agg(json_build_object('id', t.id, 'name', t.name, 'role', tm.role)) FILTER (WHERE t.id IS NOT NULL), '[]') AS teams
         FROM users u JOIN memberships om ON om.user_id=u.id AND om.team_id IS NULL
         LEFT JOIN memberships tm ON tm.user_id=u.id AND tm.team_id IS NOT NULL LEFT JOIN teams t ON t.id=tm.team_id
        WHERE om.organization_id=$1 GROUP BY u.id, om.role ORDER BY u.name`,
      [principal.organizationId]
    );
    return { users: result.rows };
  });
  app.post("/api/admin/users", async (request, reply) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "org:manage");
    const input = z.object({ name: z.string().trim().min(2).max(100), email: z.string().email().max(254), password: z.string().min(12).max(200), role: z.enum(["admin", "developer", "reviewer", "viewer"]), teamId: idSchema.optional() }).parse(request.body);
    if (input.teamId) await assertScope(principal.organizationId, "team", input.teamId);
    const passwordHash = await hash(input.password, 12);
    const userId = await transaction(async (client) => {
      const user = await client.query<{ id: string }>("INSERT INTO users (email,name,password_hash) VALUES (lower($1),$2,$3) RETURNING id", [input.email, input.name, passwordHash]);
      const id = user.rows[0]!.id;
      await client.query("INSERT INTO memberships (organization_id,team_id,user_id,role) VALUES ($1,NULL,$2,$3)", [principal.organizationId, id, input.role]);
      if (input.teamId) await client.query("INSERT INTO memberships (organization_id,team_id,user_id,role) VALUES ($1,$2,$3,$4)", [principal.organizationId, input.teamId, id, input.role]);
      return id;
    });
    await writeAudit(principal, "user.created", "user", userId, { email: input.email, role: input.role, teamId: input.teamId }, request.ip);
    return reply.code(201).send({ id: userId });
  });
  app.post("/api/admin/memberships", async (request, reply) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "org:manage");
    const input = z.object({ userId: idSchema, teamId: idSchema, role: z.enum(["admin", "developer", "reviewer", "viewer"]) }).parse(request.body);
    await assertScope(principal.organizationId, "user", input.userId);
    await assertScope(principal.organizationId, "team", input.teamId);
    await query(
      `INSERT INTO memberships (organization_id, team_id, user_id, role) VALUES ($1,$2,$3,$4)
       ON CONFLICT (organization_id, user_id, team_id) DO UPDATE SET role=excluded.role`,
      [principal.organizationId, input.teamId, input.userId, input.role]
    );
    await writeAudit(principal, "membership.upserted", "user", input.userId, { teamId: input.teamId, role: input.role }, request.ip);
    return reply.code(201).send({ ok: true });
  });
  app.get("/api/admin/providers", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "ai_policy:update");
    const result = await query(
      `SELECT id, name, base_url AS "baseUrl", default_model AS "defaultModel", allowed_models AS "allowedModels",
              input_cost_per_million::float8 AS "inputCostPerMillion", output_cost_per_million::float8 AS "outputCostPerMillion",
              enabled, encrypted_api_key IS NOT NULL AS "hasApiKey", updated_at AS "updatedAt"
         FROM ai_providers WHERE organization_id = $1 ORDER BY name`,
      [principal.organizationId]
    );
    return { providers: result.rows };
  });
  app.post("/api/admin/providers", async (request, reply) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "ai_policy:update");
    const input = z.object({
      name: z.string().trim().min(2).max(100), baseUrl: z.string().url(), apiKey: z.string().max(1000).optional(),
      defaultModel: z.string().min(1).max(200), allowedModels: z.array(z.string().min(1).max(200)).min(1).max(100),
      inputCostPerMillion: z.number().min(0).max(10000).default(0), outputCostPerMillion: z.number().min(0).max(10000).default(0)
    }).parse(request.body);
    const result = await query<{ id: string }>(
      `INSERT INTO ai_providers (organization_id, name, base_url, encrypted_api_key, default_model, allowed_models, input_cost_per_million, output_cost_per_million)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [principal.organizationId, input.name, assertSafeProviderUrl(input.baseUrl), input.apiKey ? encryptSecret(input.apiKey) : null,
        input.defaultModel, JSON.stringify(input.allowedModels), input.inputCostPerMillion, input.outputCostPerMillion]
    );
    await writeAudit(principal, "ai_provider.created", "ai_provider", result.rows[0]!.id, { name: input.name, baseUrl: input.baseUrl }, request.ip);
    return reply.code(201).send({ id: result.rows[0]!.id });
  });
  app.patch("/api/admin/providers/:providerId", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "ai_policy:update");
    const { providerId } = z.object({ providerId: idSchema }).parse(request.params);
    const input = z.object({
      name: z.string().trim().min(2).max(100), baseUrl: z.string().url(), apiKey: z.string().max(1000).optional(),
      defaultModel: z.string().min(1).max(200), allowedModels: z.array(z.string().min(1).max(200)).min(1).max(100),
      inputCostPerMillion: z.number().min(0).max(10000), outputCostPerMillion: z.number().min(0).max(10000),
      enabled: z.boolean()
    }).parse(request.body);
    const encryptedApiKey = input.apiKey ? encryptSecret(input.apiKey) : null;
    const result = await query(
      `UPDATE ai_providers SET name=$3, base_url=$4,
         encrypted_api_key=coalesce($5, encrypted_api_key), default_model=$6, allowed_models=$7,
         input_cost_per_million=$8, output_cost_per_million=$9, enabled=$10, updated_at=now()
       WHERE id=$1 AND organization_id=$2 RETURNING id`,
      [providerId, principal.organizationId, input.name, assertSafeProviderUrl(input.baseUrl), encryptedApiKey,
        input.defaultModel, JSON.stringify(input.allowedModels), input.inputCostPerMillion, input.outputCostPerMillion, input.enabled]
    );
    if (!result.rowCount) throw Object.assign(new Error("AI provider not found"), { statusCode: 404 });
    await writeAudit(principal, "ai_provider.updated", "ai_provider", providerId, {
      name: input.name, baseUrl: input.baseUrl, enabled: input.enabled, keyRotated: Boolean(input.apiKey)
    }, request.ip);
    return { ok: true };
  });
  app.get("/api/admin/policies", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "ai_policy:update");
    const result = await query("SELECT * FROM ai_policies WHERE organization_id = $1 ORDER BY scope_type", [principal.organizationId]);
    return { policies: result.rows };
  });
  app.post("/api/admin/policies", async (request, reply) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "ai_policy:update");
    const input = policyInput().parse(request.body);
    await assertScope(principal.organizationId, input.scopeType, input.scopeId);
    const result = await query<{ id: string }>(
      `INSERT INTO ai_policies (organization_id, scope_type, scope_id, default_provider_id, default_model,
        allowed_provider_ids, allowed_models, monthly_token_limit, monthly_cost_limit_usd, allow_user_override, require_approval_for)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (organization_id, scope_type, scope_id) DO UPDATE SET default_provider_id=excluded.default_provider_id,
        default_model=excluded.default_model, allowed_provider_ids=excluded.allowed_provider_ids, allowed_models=excluded.allowed_models,
        monthly_token_limit=excluded.monthly_token_limit, monthly_cost_limit_usd=excluded.monthly_cost_limit_usd,
        allow_user_override=excluded.allow_user_override, require_approval_for=excluded.require_approval_for, updated_at=now()
       RETURNING id`,
      [principal.organizationId, input.scopeType, input.scopeId, input.defaultProviderId, input.defaultModel,
        JSON.stringify(input.allowedProviderIds), JSON.stringify(input.allowedModels), input.monthlyTokenLimit,
        input.monthlyCostLimitUsd, input.allowUserOverride, JSON.stringify(input.requireApprovalFor)]
    );
    await writeAudit(principal, "ai_policy.upserted", "ai_policy", result.rows[0]!.id, { scopeType: input.scopeType, scopeId: input.scopeId }, request.ip);
    return reply.code(201).send({ id: result.rows[0]!.id });
  });
  app.get("/api/admin/hooks", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "ai_policy:update");
    const result = await query("SELECT * FROM prompt_hooks WHERE organization_id = $1 ORDER BY priority DESC", [principal.organizationId]);
    return { hooks: result.rows };
  });
  app.post("/api/admin/hooks", async (request, reply) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "ai_policy:update");
    const input = z.object({ scopeType: scopeSchema, scopeId: idSchema, phase: phaseSchema, priority: z.number().int().min(-1000).max(1000).default(0), mandatory: z.boolean().default(false), title: z.string().min(2).max(200), prompt: z.string().min(2).max(20_000) }).parse(request.body);
    await assertScope(principal.organizationId, input.scopeType, input.scopeId);
    const result = await query<{ id: string }>(
      `INSERT INTO prompt_hooks (organization_id, scope_type, scope_id, phase, priority, mandatory, title, prompt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [principal.organizationId, input.scopeType, input.scopeId, input.phase, input.priority, input.mandatory, input.title, input.prompt]
    );
    await writeAudit(principal, "prompt_hook.created", "prompt_hook", result.rows[0]!.id, { scopeType: input.scopeType, scopeId: input.scopeId, phase: input.phase }, request.ip);
    return reply.code(201).send({ id: result.rows[0]!.id });
  });
  app.get("/api/admin/audit", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "audit:read");
    const result = await query("SELECT * FROM audit_events WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 200", [principal.organizationId]);
    return { events: result.rows };
  });
}

function registerMetricsRoutes(app: FastifyInstance) {
  app.get("/api/metrics/scopes", async (request) => {
    const principal = await requirePrincipal(request);
    const scopes: Array<{ scope: ScopeType; id: string; label: string }> = [];
    if (can(principal.role, "metrics:read_global")) scopes.push({ scope: "global", id: principal.organizationId, label: principal.organizationName });
    if (can(principal.role, "metrics:read_team")) {
      const allTeams = ["owner", "admin"].includes(principal.role);
      const teams = await query<{ id: string; name: string }>(
        `SELECT t.id, t.name FROM teams t WHERE t.organization_id=$1 AND ($2::boolean OR EXISTS
          (SELECT 1 FROM memberships m WHERE m.team_id=t.id AND m.user_id=$3)) ORDER BY t.name`,
        [principal.organizationId, allTeams, principal.userId]
      );
      scopes.push(...teams.rows.map((team) => ({ scope: "team" as const, id: team.id, label: team.name })));
    }
    if (can(principal.role, "metrics:read_user")) {
      const allUsers = ["owner", "admin"].includes(principal.role);
      const users = await query<{ id: string; name: string }>(
        `SELECT u.id, u.name FROM users u JOIN memberships m ON m.user_id=u.id AND m.team_id IS NULL
          WHERE m.organization_id=$1 AND ($2::boolean OR u.id=$3) ORDER BY u.name`,
        [principal.organizationId, allUsers, principal.userId]
      );
      scopes.push(...users.rows.map((user) => ({ scope: "user" as const, id: user.id, label: user.name })));
    }
    if (can(principal.role, "metrics:read_project")) {
      const allProjects = ["owner", "admin"].includes(principal.role);
      const projects = await query<{ id: string; name: string }>(
        `SELECT p.id, p.name FROM projects p WHERE p.organization_id=$1 AND ($2::boolean OR EXISTS
          (SELECT 1 FROM memberships m WHERE m.team_id=p.team_id AND m.user_id=$3)) ORDER BY p.name`,
        [principal.organizationId, allProjects, principal.userId]
      );
      scopes.push(...projects.rows.map((project) => ({ scope: "project" as const, id: project.id, label: project.name })));
    }
    return { scopes };
  });

  app.get("/api/metrics/usage", async (request) => {
    const principal = await requirePrincipal(request);
    const input = z.object({ scope: z.enum(["global", "team", "user", "project"]).default("user"), id: idSchema.optional(), days: z.coerce.number().int().min(1).max(365).default(30) }).parse(request.query);
    const permissionsByScope: Record<typeof input.scope, Permission> = {
      global: "metrics:read_global",
      team: "metrics:read_team",
      project: "metrics:read_project",
      user: "metrics:read_user"
    };
    const permission = permissionsByScope[input.scope];
    requirePermission(principal, permission);
    const scopeId = input.scope === "global" ? principal.organizationId : input.scope === "user" ? input.id ?? principal.userId : input.id;
    if (!scopeId) throw Object.assign(new Error(`${input.scope} metrics require an id`), { statusCode: 400 });
    if (input.scope === "team" && !["owner", "admin"].includes(principal.role)) {
      const teamIds = await listMemberTeamIds(principal);
      if (!teamIds.includes(scopeId)) throw Object.assign(new Error("Team metrics access denied"), { statusCode: 403 });
    }
    if (input.scope === "user") {
      if (!["owner", "admin"].includes(principal.role) && scopeId !== principal.userId) {
        throw Object.assign(new Error("User metrics access denied"), { statusCode: 403 });
      }
      await assertScope(principal.organizationId, "user", scopeId);
    }
    if (input.scope === "project") await getAccessibleProject(principal, scopeId);
    const column = { global: "organization_id", team: "team_id", user: "user_id", project: "project_id" }[input.scope];
    const result = await query(
      `SELECT date_trunc('day', completed_at) AS day, model, sum(input_tokens)::int AS "inputTokens",
              sum(output_tokens)::int AS "outputTokens", sum(total_tokens)::int AS "totalTokens",
              sum(estimated_cost_usd)::float8 AS "estimatedCostUsd", count(*)::int AS requests
         FROM token_usage_events WHERE organization_id = $1 AND ${column} = $2 AND completed_at >= now() - ($3 || ' days')::interval
        GROUP BY 1, model ORDER BY 1`,
      [principal.organizationId, scopeId, input.days]
    );
    return { scope: input.scope, scopeId, usage: result.rows };
  });
}

function registerProjectResourceRoutes(app: FastifyInstance) {
  app.get("/api/projects/:projectId/resources", async (request) => {
    const principal = await requirePrincipal(request);
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    await getAccessibleProject(principal, projectId);
    return { resources: await listProjectResources(principal.organizationId, projectId) };
  });

  app.post("/api/projects/:projectId/resources", async (request, reply) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "project:update");
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const project = await getAccessibleProject(principal, projectId); assertProjectOperational(project);
    const input = z.object({
      kind: z.enum(["secret", "api", "smtp", "git", "service"]),
      name: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
      environment: z.enum(["development", "staging", "production", "all"]).default("development"),
      value: z.string().min(1).max(20_000).optional(),
      config: resourceConfigSchema.default({})
    }).parse(request.body);
    if (input.value || ["secret", "api", "smtp"].includes(input.kind)) requirePermission(principal, "secret:update");
    if (input.kind === "git") {
      const repositoryUrl = String(input.config.repositoryUrl ?? "");
      let url: URL;
      try { url = new URL(repositoryUrl); }
      catch { throw Object.assign(new Error("Git resources require a valid repository URL"), { statusCode: 400 }); }
      if (url.protocol !== "https:" || url.username || url.password) {
        throw Object.assign(new Error("Git resources require a credential-free HTTPS repository URL"), { statusCode: 400 });
      }
    }
    for (const [key, value] of Object.entries(input.config)) {
      if (typeof value !== "string" || !/url$/i.test(key)) continue;
      let url: URL;
      try { url = new URL(value); }
      catch { throw Object.assign(new Error(`${key} must be a valid URL`), { statusCode: 400 }); }
      if (url.username || url.password) throw Object.assign(new Error("Resource URLs cannot contain credentials"), { statusCode: 400 });
    }
    const id = await upsertProjectResource({
      organizationId: principal.organizationId, projectId, userId: principal.userId,
      kind: input.kind as Exclude<ResourceKind, "database">, name: input.name,
      environment: input.environment, value: input.value, config: input.config
    });
    await writeAudit(principal, "project_resource.upserted", "project_resource", id, {
      projectId, kind: input.kind, name: input.name, environment: input.environment, valueUpdated: Boolean(input.value)
    }, request.ip);
    return reply.code(201).send({ id });
  });

  app.post("/api/projects/:projectId/resources/database", async (request, reply) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "secret:update");
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const project = await getAccessibleProject(principal, projectId); assertProjectOperational(project);
    const id = await provisionProjectDatabase({ organizationId: principal.organizationId, projectId, userId: principal.userId });
    await writeAudit(principal, "project_database.provisioned", "project_resource", id, { projectId }, request.ip);
    return reply.code(201).send({ id });
  });

  app.delete("/api/projects/:projectId/resources/:resourceId", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "secret:update");
    const { projectId, resourceId } = z.object({ projectId: idSchema, resourceId: idSchema }).parse(request.params);
    const project = await getAccessibleProject(principal, projectId); assertProjectOperational(project);
    if (!await deleteProjectResource(principal.organizationId, projectId, resourceId)) {
      throw Object.assign(new Error("Project resource not found"), { statusCode: 404 });
    }
    await writeAudit(principal, "project_resource.deleted", "project_resource", resourceId, { projectId }, request.ip);
    return { ok: true };
  });

  app.get("/api/projects/:projectId/logs", async (request) => {
    const principal = await requirePrincipal(request);
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    await getAccessibleProject(principal, projectId);
    const result = await query(
      `SELECT id::text, run_id AS "runId", source, level, message, created_at AS "createdAt"
         FROM project_runtime_logs WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 200`,
      [principal.organizationId, projectId]
    );
    return { logs: result.rows };
  });

  app.post("/api/projects/:projectId/logs", async (request, reply) => {
    const principal = await requirePrincipal(request);
    requirePermission(principal, "agent:run");
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const project = await getAccessibleProject(principal, projectId); assertProjectOperational(project);
    const input = z.object({
      level: z.enum(["debug", "info", "warn", "error"]),
      message: z.string().trim().min(1).max(4000)
    }).parse(request.body);
    const recent = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM project_runtime_logs WHERE project_id=$1 AND source='preview' AND created_at > now() - interval '1 minute'",
      [projectId]
    );
    if (Number(recent.rows[0]?.count ?? 0) >= 120) return reply.code(429).send({ error: "Preview log rate exceeded" });
    await recordProjectLog({ organizationId: principal.organizationId, projectId, source: "preview", ...input });
    return reply.code(202).send({ ok: true });
  });
}

function policyInput() {
  return z.object({
    scopeType: scopeSchema, scopeId: idSchema, defaultProviderId: idSchema, defaultModel: z.string().min(1).max(200),
    allowedProviderIds: z.array(idSchema).min(1), allowedModels: z.array(z.string().min(1).max(200)).min(1),
    monthlyTokenLimit: z.number().int().positive(), monthlyCostLimitUsd: z.number().min(0),
    allowUserOverride: z.boolean().default(false), requireApprovalFor: z.array(phaseSchema).default([])
  });
}

async function assertScope(organizationId: string, scopeType: ScopeType, scopeId: string) {
  if (scopeType === "global" && scopeId === organizationId) return;
  if (scopeType === "global") throw Object.assign(new Error("Global scope must use the organization id"), { statusCode: 400 });
  const table = { team: "teams", user: "users", project: "projects" }[scopeType];
  if (!table) throw Object.assign(new Error("Invalid scope"), { statusCode: 400 });
  const organizationColumn = table === "users" ? null : "organization_id";
  const result = organizationColumn
    ? await query(`SELECT 1 FROM ${table} WHERE id=$1 AND ${organizationColumn}=$2`, [scopeId, organizationId])
    : await query("SELECT 1 FROM memberships WHERE user_id=$1 AND organization_id=$2", [scopeId, organizationId]);
  if (!result.rowCount) throw Object.assign(new Error("Scope does not belong to this organization"), { statusCode: 400 });
}

function slugify(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "workspace";
}

function mimeType(path: string) {
  return ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" } as Record<string, string>)[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function injectPreviewBridge(html: string, projectId: string) {
  const bridge = `<script data-vibeable-preview-bridge>(()=>{
const projectId=${JSON.stringify(projectId)};
const serialize=(value)=>{try{return typeof value==='string'?value:JSON.stringify(value)}catch{return String(value)}};
const send=(level,values)=>parent.postMessage({source:'vibeable-preview',projectId,level,message:values.map(serialize).join(' ').slice(0,4000)},'*');
for(const level of ['debug','info','warn','error']){const original=console[level]?.bind(console);console[level]=(...values)=>{original?.(...values);send(level,values)}}
addEventListener('error',(event)=>send('error',[event.message,event.filename+':'+event.lineno]));
addEventListener('unhandledrejection',(event)=>send('error',['Unhandled rejection',event.reason]));
send('info',['Preview loaded']);
})()</script>`;
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${bridge}</body>`) : `${html}${bridge}`;
}

export async function closeApp() {
  await pool.end();
}
