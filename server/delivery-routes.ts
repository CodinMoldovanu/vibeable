import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requirePrincipal } from "./auth.js";
import { config } from "./config.js";
import { query, transaction } from "./db.js";
import { adapterSchema, buildDeploymentPlan, enqueueDeployment, parseDeploymentConfig } from "./deployment-worker.js";
import { requirePermission } from "./permissions.js";
import {
  assertGitBranch, deleteProjectWorkspace, getProjectGitSettings, listProjectBranches, offloadProject,
  publicGitSettings, restoreProjectFromGit, saveProjectGitSettings, syncProjectGit
} from "./project-git.js";
import { deleteProjectResource } from "./resources.js";
import { stackRulesSchema } from "./stacks.js";
import { assertProjectOperational, getAccessibleProject, writeAudit } from "./store.js";
import {
  createDeploymentWorktree, createProjectBranch, currentCommit, ensureWorkspace, promoteProjectBranch,
  projectDirectory, removeDeploymentWorktree
} from "./workspace.js";

const idSchema = z.string().uuid();
const scopeSchema = z.enum(["global", "team", "project"]);
const environmentSchema = z.enum(["staging", "production"]);
const branchSchema = z.string().trim().min(1).max(200).transform(assertGitBranch);
const scalar = z.union([z.string().trim().max(2000), z.number().finite(), z.boolean()]);
const adapterConfigSchema = z.record(z.string().trim().min(1).max(64), scalar).refine((value) => Object.keys(value).length <= 30, "Deployment config is limited to 30 fields");

export function registerDeliveryRoutes(app: FastifyInstance) {
  registerStackRoutes(app);
  registerGitAndLifecycleRoutes(app);
  registerDeploymentProfileRoutes(app);
  registerDeploymentExecutionRoutes(app);
}

function registerStackRoutes(app: FastifyInstance) {
  app.get("/api/admin/stack-profiles", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "ai_policy:update");
    const result = await query(
      `SELECT id, scope_type AS "scopeType", scope_id AS "scopeId", name, description, rules,
              is_default AS "isDefault", enabled, updated_at AS "updatedAt"
         FROM stack_profiles WHERE organization_id=$1 ORDER BY scope_type,name`,
      [principal.organizationId]
    );
    return { profiles: result.rows };
  });

  app.post("/api/admin/stack-profiles", async (request, reply) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "ai_policy:update");
    const input = stackProfileInput().parse(request.body);
    await assertOwnedScope(principal.organizationId, input.scopeType, input.scopeId);
    const result = await transaction(async (database) => {
      if (input.isDefault) await database.query("UPDATE stack_profiles SET is_default=false WHERE organization_id=$1 AND scope_type=$2 AND scope_id=$3", [principal.organizationId, input.scopeType, input.scopeId]);
      return database.query<{ id: string }>(
        `INSERT INTO stack_profiles (organization_id,scope_type,scope_id,name,description,rules,is_default,enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [principal.organizationId, input.scopeType, input.scopeId, input.name, input.description, input.rules, input.isDefault, input.enabled]
      );
    });
    const id = result.rows[0]!.id;
    await writeAudit(principal, "stack_profile.created", "stack_profile", id, { name: input.name, scopeType: input.scopeType }, request.ip);
    return reply.code(201).send({ id });
  });

  app.patch("/api/admin/stack-profiles/:profileId", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "ai_policy:update");
    const { profileId } = z.object({ profileId: idSchema }).parse(request.params);
    const input = stackProfileInput().parse(request.body);
    await assertOwnedScope(principal.organizationId, input.scopeType, input.scopeId);
    await transaction(async (database) => {
      if (input.isDefault) await database.query("UPDATE stack_profiles SET is_default=false WHERE organization_id=$1 AND scope_type=$2 AND scope_id=$3 AND id<>$4", [principal.organizationId, input.scopeType, input.scopeId, profileId]);
      const result = await database.query(
        `UPDATE stack_profiles SET scope_type=$3,scope_id=$4,name=$5,description=$6,rules=$7,is_default=$8,enabled=$9,updated_at=now()
          WHERE id=$1 AND organization_id=$2 RETURNING id`,
        [profileId, principal.organizationId, input.scopeType, input.scopeId, input.name, input.description, input.rules, input.isDefault, input.enabled]
      );
      if (!result.rowCount) throw Object.assign(new Error("Stack profile not found"), { statusCode: 404 });
    });
    await writeAudit(principal, "stack_profile.updated", "stack_profile", profileId, { name: input.name }, request.ip);
    return { ok: true };
  });

  app.post("/api/projects/:projectId/stack-profile", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "project:update");
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const { profileId } = z.object({ profileId: idSchema.nullable() }).parse(request.body);
    const project = await getAccessibleProject(principal, projectId);
    assertProjectOperational(project);
    if (profileId) {
      const profile = await query(
        `SELECT 1 FROM stack_profiles WHERE id=$1 AND organization_id=$2 AND enabled=true AND
          ((scope_type='global' AND scope_id=$2) OR (scope_type='team' AND scope_id=$3) OR (scope_type='project' AND scope_id=$4))`,
        [profileId, principal.organizationId, project.teamId, project.id]
      );
      if (!profile.rowCount) throw Object.assign(new Error("Stack profile is not available to this project"), { statusCode: 400 });
    }
    await query("UPDATE projects SET stack_profile_id=$2,updated_at=now() WHERE id=$1", [project.id, profileId]);
    await writeAudit(principal, "project.stack_profile_selected", "project", project.id, { profileId }, request.ip);
    return { ok: true };
  });
}

function registerGitAndLifecycleRoutes(app: FastifyInstance) {
  app.get("/api/projects/:projectId/delivery", async (request) => {
    const principal = await requirePrincipal(request);
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const project = await getAccessibleProject(principal, projectId);
    const [settings, workers, profiles, stacks] = await Promise.all([
      getProjectGitSettings(principal.organizationId, project.id),
      query(`SELECT id,name,base_branch AS "baseBranch",working_branch AS "workingBranch",auto_push AS "autoPush",status,last_run_id AS "lastRunId",updated_at AS "updatedAt" FROM project_workers WHERE organization_id=$1 AND project_id=$2 ORDER BY updated_at DESC`, [principal.organizationId, project.id]),
      query(`SELECT id,name,adapter,environment,config,resource_names AS "resourceNames",enabled FROM deployment_profiles WHERE organization_id=$1 AND enabled=true AND ((scope_type='team' AND scope_id=$2) OR (scope_type='project' AND scope_id=$3)) ORDER BY environment,name`, [principal.organizationId, project.teamId, project.id]),
      query(`SELECT id,name,description,scope_type AS "scopeType",is_default AS "isDefault" FROM stack_profiles WHERE organization_id=$1 AND enabled=true AND ((scope_type='global' AND scope_id=$1) OR (scope_type='team' AND scope_id=$2) OR (scope_type='project' AND scope_id=$3)) ORDER BY scope_type,name`, [principal.organizationId, project.teamId, project.id])
    ]);
    const branches = await listProjectBranches(projectDirectory(project.id)).catch(() => []);
    const lifecycle = await query(`SELECT active_branch AS "activeBranch",stack_profile_id AS "stackProfileId",archived_at AS "archivedAt",deleted_at AS "deletedAt",offloaded_at AS "offloadedAt" FROM projects WHERE id=$1`, [project.id]);
    return { git: publicGitSettings(settings), branches, workers: workers.rows, deploymentProfiles: profiles.rows, stackProfiles: stacks.rows, ...lifecycle.rows[0] };
  });

  app.put("/api/projects/:projectId/git", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "project:update");
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params); const project = await getAccessibleProject(principal, projectId); assertProjectOperational(project);
    const input = z.object({ repositoryUrl: z.string().url(), defaultBranch: branchSchema.default("main"), branchPrefix: z.string().trim().max(100).default("vibeable/"), syncMode: z.enum(["mirror", "source"]).default("mirror"), credentialType: z.enum(["bearer", "basic"]).default("bearer"), credential: z.string().max(2000).optional(), enabled: z.boolean().default(true) }).parse(request.body);
    if (input.credential) requirePermission(principal, "secret:update");
    await saveProjectGitSettings({ organizationId: principal.organizationId, projectId, ...input });
    await writeAudit(principal, "project.git_configured", "project", projectId, { repositoryUrl: input.repositoryUrl, credentialUpdated: Boolean(input.credential) }, request.ip);
    return { ok: true };
  });

  app.post("/api/projects/:projectId/git/sync", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "project:update");
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params); const project = await getAccessibleProject(principal, projectId); assertProjectOperational(project);
    const input = z.object({ direction: z.enum(["push", "pull"]), branch: branchSchema.optional() }).parse(request.body);
    const settings = await getProjectGitSettings(principal.organizationId, project.id);
    if (!settings) throw Object.assign(new Error("Project Git settings are not configured"), { statusCode: 409 });
    await syncProjectGit(settings, input.branch ?? project.activeBranch ?? settings.defaultBranch, input.direction);
    await writeAudit(principal, `project.git_${input.direction}`, "project", project.id, { branch: input.branch ?? project.activeBranch }, request.ip);
    return { ok: true };
  });

  app.post("/api/projects/:projectId/workers", async (request, reply) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "agent:run");
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params); const project = await getAccessibleProject(principal, projectId); assertProjectOperational(project);
    const input = z.object({ name: z.string().trim().min(2).max(100), baseBranch: branchSchema.default(project.activeBranch ?? "main"), workingBranch: branchSchema, autoPush: z.boolean().default(true) }).parse(request.body);
    await createProjectBranch(projectDirectory(project.id), input.workingBranch, input.baseBranch, project.activeBranch);
    const result = await query<{ id: string }>(`INSERT INTO project_workers (organization_id,project_id,name,base_branch,working_branch,auto_push,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [principal.organizationId, project.id, input.name, input.baseBranch, input.workingBranch, input.autoPush, principal.userId]);
    await writeAudit(principal, "project_worker.created", "project_worker", result.rows[0]!.id, { projectId, branch: input.workingBranch }, request.ip);
    return reply.code(201).send({ id: result.rows[0]!.id });
  });

  app.delete("/api/projects/:projectId/workers/:workerId", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "project:update");
    const { projectId, workerId } = z.object({ projectId: idSchema, workerId: idSchema }).parse(request.params); const project = await getAccessibleProject(principal, projectId); assertProjectOperational(project);
    const result = await query("UPDATE project_workers SET status='stopped',updated_at=now() WHERE id=$1 AND project_id=$2 AND organization_id=$3 RETURNING id", [workerId, projectId, principal.organizationId]);
    if (!result.rowCount) throw Object.assign(new Error("Worker not found"), { statusCode: 404 });
    await writeAudit(principal, "project_worker.stopped", "project_worker", workerId, { projectId }, request.ip);
    return { ok: true };
  });

  app.post("/api/projects/:projectId/branches/promote", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "project:update");
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params); const project = await getAccessibleProject(principal, projectId); assertProjectOperational(project);
    const input = z.object({ branch: branchSchema, destination: branchSchema.default("main"), push: z.boolean().default(true) }).parse(request.body);
    const sha = await promoteProjectBranch(projectDirectory(project.id), input.branch, input.destination);
    const settings = await getProjectGitSettings(principal.organizationId, project.id);
    if (input.push && settings) await syncProjectGit(settings, input.destination, "push");
    await query("UPDATE projects SET active_branch=$2,updated_at=now() WHERE id=$1", [project.id, input.destination]);
    await writeAudit(principal, "project.branch_promoted", "project", project.id, { ...input, sha }, request.ip);
    return { ok: true, commitSha: sha };
  });

  app.post("/api/projects/:projectId/archive", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "project:update");
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params); const project = await getAccessibleProject(principal, projectId); assertProjectOperational(project);
    const { offload } = z.object({ offload: z.boolean().default(false) }).parse(request.body ?? {});
    await assertNoActiveWork(project.id);
    if (offload) {
      const settings = await getProjectGitSettings(principal.organizationId, project.id);
      if (!settings) throw Object.assign(new Error("Git must be configured before offloading"), { statusCode: 409 });
      await offloadProject(settings, project.activeBranch ?? settings.defaultBranch);
    }
    await query("UPDATE projects SET archived_at=now(),offloaded_at=CASE WHEN $2 THEN now() ELSE offloaded_at END,updated_at=now() WHERE id=$1", [project.id, offload]);
    await writeAudit(principal, offload ? "project.offloaded" : "project.archived", "project", project.id, {}, request.ip);
    return { ok: true };
  });

  app.post("/api/projects/:projectId/restore", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "project:update");
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params); const project = await getAccessibleProject(principal, projectId);
    if (!project.archivedAt && !project.deletedAt && !project.offloadedAt) throw Object.assign(new Error("Project is already active"), { statusCode: 409 });
    if (project.offloadedAt) {
      const settings = await getProjectGitSettings(principal.organizationId, project.id);
      if (!settings) throw Object.assign(new Error("Git settings are required to restore an offloaded project"), { statusCode: 409 });
      await restoreProjectFromGit(settings, project.activeBranch ?? settings.defaultBranch);
    } else await ensureWorkspace(project.id, project.name);
    await query("UPDATE projects SET archived_at=NULL,deleted_at=NULL,offloaded_at=NULL,status='ready',updated_at=now() WHERE id=$1", [project.id]);
    await writeAudit(principal, "project.restored", "project", project.id, {}, request.ip);
    return { ok: true };
  });

  app.delete("/api/projects/:projectId", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "project:update");
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params); const project = await getAccessibleProject(principal, projectId);
    await assertNoActiveWork(project.id);
    await query("UPDATE projects SET deleted_at=now(),archived_at=coalesce(archived_at,now()),updated_at=now() WHERE id=$1", [project.id]);
    await writeAudit(principal, "project.trashed", "project", project.id, {}, request.ip);
    return { ok: true };
  });

  app.delete("/api/projects/:projectId/purge", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "org:manage");
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params); const project = await getAccessibleProject(principal, projectId);
    if (!project.deletedAt) throw Object.assign(new Error("Project must be moved to trash before it can be purged"), { statusCode: 409 });
    await assertNoActiveWork(project.id);
    const resources = await query<{ id: string }>("SELECT id FROM project_resources WHERE organization_id=$1 AND project_id=$2", [principal.organizationId, project.id]);
    for (const resource of resources.rows) await deleteProjectResource(principal.organizationId, project.id, resource.id);
    await deleteProjectWorkspace(project.id);
    await query("DELETE FROM projects WHERE id=$1 AND organization_id=$2", [project.id, principal.organizationId]);
    await writeAudit(principal, "project.purged", "project", project.id, {}, request.ip);
    return { ok: true };
  });
}

function registerDeploymentProfileRoutes(app: FastifyInstance) {
  app.get("/api/admin/deployment-profiles", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "ai_policy:update");
    const result = await query(`SELECT id,scope_type AS "scopeType",scope_id AS "scopeId",name,adapter,environment,config,resource_names AS "resourceNames",enabled,updated_at AS "updatedAt" FROM deployment_profiles WHERE organization_id=$1 ORDER BY environment,name`, [principal.organizationId]);
    return { profiles: result.rows };
  });
  app.post("/api/admin/deployment-profiles", async (request, reply) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "ai_policy:update");
    const input = deploymentProfileInput().parse(request.body); await assertOwnedScope(principal.organizationId, input.scopeType, input.scopeId);
    const parsedConfig = parseDeploymentConfig(input.adapter, input.config);
    const result = await query<{ id: string }>(`INSERT INTO deployment_profiles (organization_id,scope_type,scope_id,name,adapter,environment,config,resource_names,enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [principal.organizationId, input.scopeType, input.scopeId, input.name, input.adapter, input.environment, parsedConfig, JSON.stringify(input.resourceNames), input.enabled]);
    await writeAudit(principal, "deployment_profile.created", "deployment_profile", result.rows[0]!.id, { adapter: input.adapter, environment: input.environment }, request.ip);
    return reply.code(201).send({ id: result.rows[0]!.id });
  });
  app.patch("/api/admin/deployment-profiles/:profileId", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "ai_policy:update");
    const { profileId } = z.object({ profileId: idSchema }).parse(request.params); const input = deploymentProfileInput().parse(request.body); await assertOwnedScope(principal.organizationId, input.scopeType, input.scopeId);
    const result = await query(`UPDATE deployment_profiles SET scope_type=$3,scope_id=$4,name=$5,adapter=$6,environment=$7,config=$8,resource_names=$9,enabled=$10,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING id`, [profileId, principal.organizationId, input.scopeType, input.scopeId, input.name, input.adapter, input.environment, parseDeploymentConfig(input.adapter, input.config), JSON.stringify(input.resourceNames), input.enabled]);
    if (!result.rowCount) throw Object.assign(new Error("Deployment profile not found"), { statusCode: 404 });
    await writeAudit(principal, "deployment_profile.updated", "deployment_profile", profileId, { adapter: input.adapter, environment: input.environment }, request.ip);
    return { ok: true };
  });
}

function registerDeploymentExecutionRoutes(app: FastifyInstance) {
  app.get("/api/projects/:projectId/deployments", async (request) => {
    const principal = await requirePrincipal(request); const { projectId } = z.object({ projectId: idSchema }).parse(request.params); await getAccessibleProject(principal, projectId);
    const result = await query(`SELECT d.id,d.environment,d.status,d.requested_by AS "requestedBy",d.approved_by AS "approvedBy",d.commit_sha AS "commitSha",d.branch,d.plan,d.rollback_of AS "rollbackOf",d.started_at AS "startedAt",d.finished_at AS "finishedAt",d.created_at AS "createdAt",coalesce(d.deployment_profile_name,p.name) AS "profileName",coalesce(d.adapter,p.adapter) AS adapter,coalesce((SELECT json_agg(json_build_object('id',e.id::text,'type',e.type,'level',e.level,'message',e.message,'metadata',e.metadata,'createdAt',e.created_at) ORDER BY e.created_at) FROM deployment_events e WHERE e.deployment_id=d.id),'[]') AS events FROM deployments d LEFT JOIN deployment_profiles p ON p.id=d.profile_id WHERE d.project_id=$1 ORDER BY d.created_at DESC`, [projectId]);
    return { deployments: result.rows };
  });

  app.post("/api/projects/:projectId/deployments", async (request, reply) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "deployment:create");
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params); const project = await getAccessibleProject(principal, projectId); assertProjectOperational(project);
    const input = z.object({ profileId: idSchema, branch: branchSchema.optional() }).parse(request.body);
    const profile = await loadAvailableDeploymentProfile(principal.organizationId, project.teamId, project.id, input.profileId);
    const branch = input.branch ?? project.activeBranch ?? "main";
    const commitSha = await currentCommit(projectDirectory(project.id), branch);
    const deploymentId = randomUUID();
    const plan = await buildPlanAtCommit(project.id, deploymentId, profile.adapter, profile.config, branch, commitSha);
    const status = profile.environment === "production" ? "waiting_approval" : "approved";
    await transaction(async (database) => {
      await database.query(`INSERT INTO deployments (id,organization_id,project_id,requested_by,environment,status,profile_id,branch,commit_sha,plan,deployment_profile_name,adapter,adapter_config,resource_names) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [deploymentId, principal.organizationId, project.id, principal.userId, profile.environment, status, profile.id, branch, commitSha, plan, profile.name, profile.adapter, profile.config, JSON.stringify(profile.resourceNames)]);
      await database.query("INSERT INTO deployment_events (deployment_id,type,message,metadata) VALUES ($1,'plan',$2,$3)", [deploymentId, plan.action, plan]);
      await writeAudit(principal, "deployment.planned", "deployment", deploymentId, { projectId, profileId: profile.id, branch, commitSha }, request.ip, database);
    });
    return reply.code(201).send({ id: deploymentId, status, plan });
  });

  app.post("/api/deployments/:deploymentId/approve", async (request) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "deployment:approve");
    const { deploymentId } = z.object({ deploymentId: idSchema }).parse(request.params);
    const existing = await query<{ projectId: string }>("SELECT project_id AS \"projectId\" FROM deployments WHERE id=$1 AND organization_id=$2", [deploymentId, principal.organizationId]);
    if (!existing.rows[0]) throw Object.assign(new Error("Deployment not found"), { statusCode: 404 }); const project = await getAccessibleProject(principal, existing.rows[0].projectId); assertProjectOperational(project);
    await transaction(async (database) => {
      const result = await database.query(`UPDATE deployments SET status='approved',approved_by=$2,approved_at=now(),updated_at=now() WHERE id=$1 AND organization_id=$3 AND status='waiting_approval' AND ($4::boolean=false OR requested_by<>$2) RETURNING id`, [deploymentId, principal.userId, principal.organizationId, config.requireSeparateApprover]);
      if (!result.rowCount) throw Object.assign(new Error("Deployment is not awaiting approval or requires a different approver"), { statusCode: 409 });
      await database.query("INSERT INTO deployment_events (deployment_id,type,message) VALUES ($1,'approval','Deployment approved')", [deploymentId]);
      await writeAudit(principal, "deployment.approved", "deployment", deploymentId, { projectId: project.id }, request.ip, database);
    });
    return { ok: true };
  });

  app.post("/api/deployments/:deploymentId/execute", async (request, reply) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "deployment:create");
    const { deploymentId } = z.object({ deploymentId: idSchema }).parse(request.params);
    const existing = await query<{ projectId: string }>("SELECT project_id AS \"projectId\" FROM deployments WHERE id=$1 AND organization_id=$2", [deploymentId, principal.organizationId]);
    if (!existing.rows[0]) return reply.code(404).send({ error: "Deployment not found" }); const project = await getAccessibleProject(principal, existing.rows[0].projectId); assertProjectOperational(project);
    if (config.DEPLOYMENT_EXECUTION_MODE === "disabled") return reply.code(409).send({ error: "Deployment execution is disabled by the operator" });
    const started = await transaction(async (database) => {
      const result = await database.query("UPDATE deployments SET status='running',started_at=now(),updated_at=now() WHERE id=$1 AND status='approved' RETURNING id", [deploymentId]);
      if (!result.rowCount) return false;
      await database.query("INSERT INTO deployment_events (deployment_id,type,message) VALUES ($1,'start','Deployment worker started')", [deploymentId]);
      await writeAudit(principal, "deployment.executed", "deployment", deploymentId, { projectId: project.id }, request.ip, database);
      return true;
    });
    if (!started) return reply.code(409).send({ error: "Deployment is not approved" });
    enqueueDeployment(deploymentId);
    return reply.code(202).send({ ok: true });
  });

  app.post("/api/deployments/:deploymentId/rollback", async (request, reply) => {
    const principal = await requirePrincipal(request); requirePermission(principal, "deployment:create");
    const { deploymentId } = z.object({ deploymentId: idSchema }).parse(request.params);
    const source = await query<{ id: string; projectId: string; environment: string; profileId: string; branch: string; commitSha: string }>(`SELECT id,project_id AS "projectId",environment,profile_id AS "profileId",branch,commit_sha AS "commitSha" FROM deployments WHERE id=$1 AND organization_id=$2 AND status='deployed'`, [deploymentId, principal.organizationId]);
    const current = source.rows[0]; if (!current) return reply.code(409).send({ error: "Only a deployed release can be rolled back" }); const project = await getAccessibleProject(principal, current.projectId); assertProjectOperational(project);
    const previous = await query<{ commitSha: string; branch: string; profileId: string; profileName: string; adapter: z.infer<typeof adapterSchema>; config: Record<string, unknown>; resourceNames: string[] }>(`SELECT commit_sha AS "commitSha",branch,profile_id AS "profileId",deployment_profile_name AS "profileName",adapter,adapter_config AS config,resource_names AS "resourceNames" FROM deployments WHERE project_id=$1 AND environment=$2 AND profile_id=$3 AND status IN ('deployed','rolled_back') AND id<>$4 AND commit_sha<>$5 AND adapter IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [current.projectId, current.environment, current.profileId, current.id, current.commitSha]);
    const target = previous.rows[0];
    if (!target) return reply.code(409).send({ error: "No previous successful deployment is available" });
    const status = current.environment === "production" ? "waiting_approval" : "approved";
    const rollbackId = randomUUID();
    const basePlan = await buildPlanAtCommit(project.id, rollbackId, target.adapter, target.config, target.branch, target.commitSha);
    const plan = { ...basePlan, action: `Rollback: ${basePlan.action}` };
    await transaction(async (database) => {
      await database.query(`INSERT INTO deployments (id,organization_id,project_id,requested_by,environment,status,profile_id,branch,commit_sha,plan,rollback_of,deployment_profile_name,adapter,adapter_config,resource_names) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [rollbackId, principal.organizationId, current.projectId, principal.userId, current.environment, status, target.profileId, target.branch, target.commitSha, plan, current.id, target.profileName, target.adapter, target.config, JSON.stringify(target.resourceNames)]);
      await database.query("INSERT INTO deployment_events (deployment_id,type,message,metadata) VALUES ($1,'rollback',$2,$3)", [rollbackId, `Rollback planned to ${target.commitSha.slice(0, 8)}`, plan]);
      await writeAudit(principal, "deployment.rollback_planned", "deployment", rollbackId, { projectId: project.id, rollbackOf: current.id, commitSha: target.commitSha }, request.ip, database);
    });
    return reply.code(201).send({ id: rollbackId, status, plan });
  });
}

function stackProfileInput() { return z.object({ scopeType: scopeSchema, scopeId: idSchema, name: z.string().trim().min(2).max(100), description: z.string().trim().max(1000).default(""), rules: stackRulesSchema, isDefault: z.boolean().default(false), enabled: z.boolean().default(true) }); }
function deploymentProfileInput() { return z.object({ scopeType: z.enum(["team", "project"]), scopeId: idSchema, name: z.string().trim().min(2).max(100), adapter: adapterSchema, environment: environmentSchema, config: adapterConfigSchema, resourceNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/)).max(50).default([]), enabled: z.boolean().default(true) }); }

async function assertOwnedScope(organizationId: string, scopeType: "global" | "team" | "project", scopeId: string) {
  if (scopeType === "global") { if (scopeId !== organizationId) throw Object.assign(new Error("Global scope must use the organization id"), { statusCode: 400 }); return; }
  const table = scopeType === "team" ? "teams" : "projects";
  const result = await query(`SELECT 1 FROM ${table} WHERE id=$1 AND organization_id=$2`, [scopeId, organizationId]);
  if (!result.rowCount) throw Object.assign(new Error("Scope does not belong to this organization"), { statusCode: 400 });
}
async function assertNoActiveWork(projectId: string) {
  const result = await query<{ active: boolean }>(`SELECT EXISTS (SELECT 1 FROM agent_runs WHERE project_id=$1 AND status IN ('waiting_approval','queued','planning','editing','testing')) OR EXISTS (SELECT 1 FROM deployments WHERE project_id=$1 AND status='running') AS active`, [projectId]);
  if (result.rows[0]?.active) throw Object.assign(new Error("Project has an active agent run or deployment"), { statusCode: 409 });
}
async function loadAvailableDeploymentProfile(organizationId: string, teamId: string, projectId: string, profileId: string) {
  const result = await query<{ id: string; name: string; adapter: z.infer<typeof adapterSchema>; environment: "staging" | "production"; config: Record<string, unknown>; resourceNames: string[] }>(`SELECT id,name,adapter,environment,config,resource_names AS "resourceNames" FROM deployment_profiles WHERE id=$1 AND organization_id=$2 AND enabled=true AND ((scope_type='team' AND scope_id=$3) OR (scope_type='project' AND scope_id=$4))`, [profileId, organizationId, teamId, projectId]);
  if (!result.rows[0]) throw Object.assign(new Error("Deployment profile is not available to this project"), { statusCode: 400 }); return result.rows[0];
}

async function buildPlanAtCommit(projectId: string, deploymentId: string, adapter: z.infer<typeof adapterSchema>, adapterConfig: Record<string, unknown>, branch: string, commitSha: string) {
  const root = projectDirectory(projectId);
  const worktree = await createDeploymentWorktree(root, deploymentId, commitSha);
  try {
    return await buildDeploymentPlan({ adapter, config: adapterConfig, directory: worktree, branch, commitSha });
  } finally {
    await removeDeploymentWorktree(root, worktree);
  }
}
