import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { lstat, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { Agent, fetch as pinnedFetch } from "undici";
import { z } from "zod";
import { config } from "./config.js";
import { query } from "./db.js";
import { getProjectGitSettings, pushExactProjectCommit } from "./project-git.js";
import { projectRuntimeEnvironment } from "./resources.js";
import { assertSafeProviderResolution } from "./security.js";
import { createDeploymentWorktree, projectDirectory, removeDeploymentWorktree } from "./workspace.js";

const execFileAsync = promisify(execFile);
const safeText = z.string().trim().min(1).max(300)
  .refine((value) => !value.startsWith("-") && !/[\0\r\n]/.test(value), "Value cannot be interpreted as an option or contain control characters");
const safePath = z.string().trim().min(1).max(500).refine((value) => !value.startsWith("/") && !value.split(/[\\/]/).includes(".."), "Path must be relative");

export const adapterSchema = z.enum(["kubernetes", "helm", "docker_swarm", "compose", "gitops", "webhook"]);
export type DeploymentAdapter = z.infer<typeof adapterSchema>;

const healthFields = { healthUrl: z.string().url().optional(), expectedStatus: z.number().int().min(100).max(599).default(200) };
export const deploymentConfigSchemas = {
  kubernetes: z.object({ manifestPath: safePath, context: safeText.optional(), namespace: safeText.optional(), rolloutResource: safeText.optional(), ...healthFields }).strict(),
  helm: z.object({ chartPath: safePath, release: safeText, namespace: safeText, valuesPath: safePath.optional(), context: safeText.optional(), ...healthFields }).strict(),
  docker_swarm: z.object({ composePath: safePath, stack: safeText, ...healthFields }).strict(),
  compose: z.object({ composePath: safePath, projectName: safeText.optional(), ...healthFields }).strict(),
  gitops: z.object({ branch: safeText.optional(), ...healthFields }).strict(),
  webhook: z.object({ url: z.string().url(), authResource: safeText.optional(), ...healthFields }).strict()
} satisfies Record<DeploymentAdapter, z.ZodType>;

interface DeploymentRow {
  id: string; organizationId: string; projectId: string; environment: "staging" | "production";
  commitSha: string; branch: string; status: string; profileId: string; adapter: DeploymentAdapter;
  config: Record<string, unknown>; resourceNames: string[];
}

export function parseDeploymentConfig(adapter: DeploymentAdapter, value: unknown) {
  return deploymentConfigSchemas[adapter].parse(value) as Record<string, unknown>;
}

export async function buildDeploymentPlan(input: {
  adapter: DeploymentAdapter; config: Record<string, unknown>; directory: string; branch: string; commitSha: string;
}) {
  const files: string[] = [];
  for (const key of ["manifestPath", "chartPath", "valuesPath", "composePath"] as const) {
    const value = input.config[key];
    if (typeof value === "string") {
      await assertWorkspacePath(input.directory, value);
      files.push(value);
    }
  }
  if (input.adapter === "webhook") await assertSafeProviderResolution(String(input.config.url));
  if (typeof input.config.healthUrl === "string") await assertSafeProviderResolution(input.config.healthUrl);
  return {
    adapter: input.adapter,
    branch: input.branch,
    commitSha: input.commitSha,
    files,
    action: describeAction(input.adapter, input.config),
    healthUrl: input.config.healthUrl ?? null
  };
}

export function enqueueDeployment(deploymentId: string) {
  setImmediate(() => void executeDeployment(deploymentId));
}

export async function executeDeployment(deploymentId: string) {
  let worktree: string | undefined;
  let projectRoot: string | undefined;
  try {
    if (config.DEPLOYMENT_EXECUTION_MODE === "disabled") throw Object.assign(new Error("Deployment execution is disabled by the operator"), { code: "execution_disabled" });
    const result = await query<DeploymentRow>(
      `SELECT d.id, d.organization_id AS "organizationId", d.project_id AS "projectId", d.environment,
              d.commit_sha AS "commitSha", d.branch, d.status, d.profile_id AS "profileId",
              d.adapter, d.adapter_config AS config, d.resource_names AS "resourceNames"
         FROM deployments d
        WHERE d.id=$1`,
      [deploymentId]
    );
    const deployment = result.rows[0];
    if (!deployment || deployment.status !== "running") return;
    if (!deployment.adapter || !deployment.config || !deployment.resourceNames) throw new Error("Deployment is missing its immutable execution snapshot");
    projectRoot = projectDirectory(deployment.projectId);
    worktree = await createDeploymentWorktree(projectRoot, deployment.id, deployment.commitSha);
    const allEnvironment = await projectRuntimeEnvironment(deployment.organizationId, deployment.projectId, deployment.environment);
    const selectedEnvironment = Object.fromEntries(deployment.resourceNames.filter((name) => name in allEnvironment).map((name) => [name, allEnvironment[name]! ]));
    await event(deployment.id, "execute", `Executing ${deployment.adapter} deployment for ${deployment.commitSha.slice(0, 8)}`);
    const output = await runAdapter(deployment, worktree, selectedEnvironment);
    if (output) await event(deployment.id, "output", redactEnvironment(output, Object.values(selectedEnvironment)), "info");
    if (typeof deployment.config.healthUrl === "string") {
      await event(deployment.id, "health", `Checking ${new URL(deployment.config.healthUrl).origin}`);
      await checkHealth(deployment.config.healthUrl, Number(deployment.config.expectedStatus ?? 200));
    }
    await query("UPDATE deployments SET status='deployed', finished_at=now(), updated_at=now() WHERE id=$1", [deployment.id]);
    await query("UPDATE projects SET status='deployed', environment=$2, updated_at=now() WHERE id=$1", [deployment.projectId, deployment.environment]);
    if (await isRollback(deployment.id)) {
      const rollback = await query<{ rollbackOf: string }>("SELECT rollback_of AS \"rollbackOf\" FROM deployments WHERE id=$1", [deployment.id]);
      if (rollback.rows[0]?.rollbackOf) await query("UPDATE deployments SET status='rolled_back', updated_at=now() WHERE id=$1", [rollback.rows[0].rollbackOf]);
    }
    await event(deployment.id, "complete", "Deployment completed and health checks passed");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown deployment failure";
    await query("UPDATE deployments SET status='failed', error_code=$2, finished_at=now(), updated_at=now() WHERE id=$1", [deploymentId, classify(error)]).catch(() => undefined);
    await event(deploymentId, "error", message.slice(0, 4000), "error").catch(() => undefined);
  } finally {
    if (worktree && projectRoot) await removeDeploymentWorktree(projectRoot, worktree);
  }
}

async function runAdapter(deployment: DeploymentRow, directory: string, environment: Record<string, string>) {
  const adapter = deployment.adapter;
  const value = deployment.config;
  if (adapter === "gitops") {
    const settings = await getProjectGitSettings(deployment.organizationId, deployment.projectId);
    if (!settings) throw new Error("GitOps requires project Git settings");
    await pushExactProjectCommit(settings, directory, deployment.commitSha, String(value.branch ?? deployment.branch));
    return `Pushed GitOps branch ${String(value.branch ?? deployment.branch)}`;
  }
  if (adapter === "webhook") {
    const token = typeof value.authResource === "string" ? environment[value.authResource] : undefined;
    await postWebhook(String(value.url), { deploymentId: deployment.id, projectId: deployment.projectId, environment: deployment.environment, branch: deployment.branch, commitSha: deployment.commitSha }, token);
    return "Webhook accepted the deployment request.";
  }
  const command = adapterCommand(adapter, value);
  const { stdout, stderr } = await execFileAsync(command.binary, command.args, {
    cwd: directory, env: { ...process.env, ...environment }, timeout: 600_000, maxBuffer: 4_000_000
  });
  return `${stdout}\n${stderr}`.trim();
}

function adapterCommand(adapter: Exclude<DeploymentAdapter, "gitops" | "webhook">, value: Record<string, unknown>) {
  if (adapter === "kubernetes") {
    const args = [...optionalFlag("--context", value.context), ...optionalFlag("--namespace", value.namespace), "apply", "-f", String(value.manifestPath)];
    return { binary: "kubectl", args };
  }
  if (adapter === "helm") {
    const args = ["upgrade", "--install", String(value.release), String(value.chartPath), "--namespace", String(value.namespace), "--create-namespace", ...optionalFlag("--kube-context", value.context), ...optionalFlag("--values", value.valuesPath)];
    return { binary: "helm", args };
  }
  if (adapter === "docker_swarm") return { binary: "docker", args: ["stack", "deploy", "-c", String(value.composePath), String(value.stack)] };
  return { binary: "docker", args: ["compose", "-f", String(value.composePath), ...optionalFlag("--project-name", value.projectName), "up", "-d", "--remove-orphans"] };
}

async function postWebhook(url: string, payload: Record<string, unknown>, token?: string) {
  const endpoint = await assertSafeProviderResolution(url);
  const dispatcher = new Agent({ connect: { lookup: (_hostname, options, callback) => options.all ? callback(null, [{ address: endpoint.address, family: endpoint.family }]) : callback(null, endpoint.address, endpoint.family) } });
  try {
    const response = await pinnedFetch(endpoint.url, { method: "POST", redirect: "error", dispatcher, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`Deployment webhook returned HTTP ${response.status}`);
  } finally { await dispatcher.close(); }
}

async function checkHealth(url: string, expectedStatus: number) {
  const endpoint = await assertSafeProviderResolution(url);
  const addresses = await lookup(new URL(endpoint.url).hostname, { all: true });
  if (!addresses.some((address) => address.address === endpoint.address && address.family === endpoint.family)) throw new Error("Health endpoint DNS changed during validation");
  const dispatcher = new Agent({ connect: { lookup: (_hostname, options, callback) => options.all ? callback(null, [{ address: endpoint.address, family: endpoint.family }]) : callback(null, endpoint.address, endpoint.family) } });
  try {
    const response = await pinnedFetch(endpoint.url, { method: "GET", redirect: "error", dispatcher });
    if (response.status !== expectedStatus) throw new Error(`Health check returned HTTP ${response.status}; expected ${expectedStatus}`);
  } finally { await dispatcher.close(); }
}

async function assertWorkspacePath(directory: string, path: string) {
  const root = await realpath(directory);
  const candidate = resolve(root, path);
  if (!candidate.startsWith(`${root}${sep}`)) throw new Error(`Deployment path escapes workspace: ${path}`);
  const target = await lstat(candidate).catch(() => null);
  if (!target || target.isSymbolicLink()) throw new Error(`Deployment path not found or unsafe: ${path}`);
  const resolvedTarget = await realpath(candidate);
  if (!resolvedTarget.startsWith(`${root}${sep}`)) throw new Error(`Deployment path escapes workspace through a symbolic link: ${path}`);
}

async function event(deploymentId: string, type: string, message: string, level: "debug" | "info" | "warn" | "error" = "info", metadata: Record<string, unknown> = {}) {
  await query("INSERT INTO deployment_events (deployment_id,type,message,level,metadata) VALUES ($1,$2,$3,$4,$5)", [deploymentId, type, message, level, metadata]);
}

function optionalFlag(name: string, value: unknown) { return typeof value === "string" && value ? [name, value] : []; }
function describeAction(adapter: DeploymentAdapter, value: Record<string, unknown>) {
  if (adapter === "kubernetes") return `Apply ${String(value.manifestPath)}`;
  if (adapter === "helm") return `Upgrade Helm release ${String(value.release)}`;
  if (adapter === "docker_swarm") return `Deploy Swarm stack ${String(value.stack)}`;
  if (adapter === "compose") return `Reconcile Compose project ${String(value.projectName ?? "default")}`;
  if (adapter === "gitops") return `Push GitOps branch ${String(value.branch ?? "deployment branch")}`;
  return `POST deployment payload to ${new URL(String(value.url)).origin}`;
}
function redactEnvironment(value: string, secrets: string[]) { return secrets.reduce((output, secret) => secret ? output.replaceAll(secret, "[redacted]") : output, value).slice(0, 4000); }
function classify(error: unknown) { return typeof error === "object" && error && "code" in error ? String(error.code) : "deployment_failed"; }
async function isRollback(deploymentId: string) { const result = await query("SELECT 1 FROM deployments WHERE id=$1 AND rollback_of IS NOT NULL", [deploymentId]); return Boolean(result.rowCount); }
