import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { query } from "./db.js";
import { assertSafeProviderResolution, assertSafeProviderUrl, decryptSecret, encryptSecret } from "./security.js";
import { projectDirectory } from "./workspace.js";

const execFileAsync = promisify(execFile);
const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";

export interface ProjectGitSettings {
  projectId: string;
  repositoryUrl: string;
  defaultBranch: string;
  branchPrefix: string;
  syncMode: "mirror" | "source";
  credentialType: "bearer" | "basic";
  encryptedCredential: string | null;
  enabled: boolean;
  lastSyncAt?: string;
  lastSyncStatus?: string;
}

export function assertGitBranch(value: string) {
  const branch = value.trim();
  if (!branch || branch.length > 200 || branch.startsWith("-") || branch.endsWith("/") || branch.includes("..") || branch.includes("@{") || /[~^:?*\[\\\s]/.test(branch)) {
    throw Object.assign(new Error("Invalid Git branch name"), { statusCode: 400 });
  }
  return branch;
}

export async function getProjectGitSettings(organizationId: string, projectId: string) {
  const result = await query<ProjectGitSettings>(
    `SELECT project_id AS "projectId", repository_url AS "repositoryUrl", default_branch AS "defaultBranch",
            branch_prefix AS "branchPrefix", sync_mode AS "syncMode", credential_type AS "credentialType",
            encrypted_credential AS "encryptedCredential", enabled, last_sync_at AS "lastSyncAt",
            last_sync_status AS "lastSyncStatus"
       FROM project_git_settings WHERE organization_id=$1 AND project_id=$2`,
    [organizationId, projectId]
  );
  return result.rows[0] ?? null;
}

export async function saveProjectGitSettings(input: {
  organizationId: string; projectId: string; repositoryUrl: string; defaultBranch: string;
  branchPrefix: string; syncMode: "mirror" | "source"; credentialType: "bearer" | "basic";
  credential?: string; enabled: boolean;
}) {
  const repositoryUrl = assertSafeProviderUrl(input.repositoryUrl);
  const defaultBranch = assertGitBranch(input.defaultBranch);
  const branchPrefix = input.branchPrefix ? `${assertGitBranch(input.branchPrefix.replace(/\/$/, ""))}/` : "";
  await query(
    `INSERT INTO project_git_settings
      (project_id, organization_id, repository_url, default_branch, branch_prefix, sync_mode, credential_type, encrypted_credential, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (project_id) DO UPDATE SET repository_url=excluded.repository_url,
       default_branch=excluded.default_branch, branch_prefix=excluded.branch_prefix, sync_mode=excluded.sync_mode,
       credential_type=excluded.credential_type,
       encrypted_credential=coalesce(excluded.encrypted_credential, project_git_settings.encrypted_credential),
       enabled=excluded.enabled, updated_at=now()`,
    [input.projectId, input.organizationId, repositoryUrl, defaultBranch, branchPrefix, input.syncMode,
      input.credentialType, input.credential ? encryptSecret(input.credential) : null, input.enabled]
  );
}

export function publicGitSettings(settings: ProjectGitSettings | null) {
  if (!settings) return null;
  const { encryptedCredential, ...publicSettings } = settings;
  return { ...publicSettings, hasCredential: Boolean(encryptedCredential) };
}

export async function listProjectBranches(directory: string) {
  if (!await exists(join(directory, ".git"))) return [];
  const result = await git(directory, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return result.stdout.split("\n").map((value) => value.trim()).filter(Boolean).sort();
}

export async function syncProjectGit(settings: ProjectGitSettings, branch: string, direction: "push" | "pull") {
  if (!settings.enabled) throw Object.assign(new Error("Project Git synchronization is disabled"), { statusCode: 409 });
  await assertSafeProviderResolution(settings.repositoryUrl);
  const directory = projectDirectory(settings.projectId);
  const targetBranch = assertGitBranch(branch);
  if (direction === "pull" && !await exists(join(directory, ".git"))) await cloneProject(settings, targetBranch);
  else {
    await ensureRemote(directory, settings);
    if (direction === "pull") {
      await git(directory, ["fetch", "--prune", "vibeable"], settings);
      const remote = `refs/remotes/vibeable/${targetBranch}`;
      if (!(await refExists(directory, remote))) throw Object.assign(new Error(`Remote branch not found: ${targetBranch}`), { statusCode: 404 });
      if (await refExists(directory, `refs/heads/${targetBranch}`)) {
        await git(directory, ["checkout", targetBranch], settings);
        await git(directory, ["merge", "--ff-only", remote], settings);
      } else {
        await git(directory, ["checkout", "-b", targetBranch, remote], settings);
      }
    } else {
      await git(directory, ["push", "vibeable", `${targetBranch}:${targetBranch}`], settings);
    }
  }
  await query("UPDATE project_git_settings SET last_sync_at=now(), last_sync_status='success', updated_at=now() WHERE project_id=$1", [settings.projectId]);
}

export async function pushExactProjectCommit(settings: ProjectGitSettings, directory: string, commitSha: string, branch: string) {
  if (!settings.enabled) throw Object.assign(new Error("Project Git synchronization is disabled"), { statusCode: 409 });
  if (!/^[a-f0-9]{40}$/.test(commitSha)) throw Object.assign(new Error("Invalid Git commit SHA"), { statusCode: 400 });
  const targetBranch = assertGitBranch(branch);
  await assertSafeProviderResolution(settings.repositoryUrl);
  await ensureRemote(directory, settings);
  const checkedOutCommit = (await git(directory, ["rev-parse", "HEAD"], settings)).stdout.trim();
  if (checkedOutCommit !== commitSha) throw new Error("Deployment worktree does not match the approved commit");
  try {
    await git(directory, ["push", "vibeable", `HEAD:refs/heads/${targetBranch}`], settings);
    await query("UPDATE project_git_settings SET last_sync_at=now(), last_sync_status='success', updated_at=now() WHERE project_id=$1", [settings.projectId]);
  } catch (error) {
    await query("UPDATE project_git_settings SET last_sync_at=now(), last_sync_status='failed', updated_at=now() WHERE project_id=$1", [settings.projectId]);
    throw error;
  }
}

export async function pushRunBranches(settings: ProjectGitSettings, directory: string, targetBranch: string, runBranch: string) {
  if (!settings.enabled) return;
  try {
    await assertSafeProviderResolution(settings.repositoryUrl);
    await ensureRemote(directory, settings);
    const refs = settings.syncMode === "mirror"
      ? [`${targetBranch}:${targetBranch}`, `${runBranch}:${runBranch}`]
      : [`${targetBranch}:${targetBranch}`];
    await git(directory, ["push", "vibeable", ...refs], settings);
    await query("UPDATE project_git_settings SET last_sync_at=now(), last_sync_status='success', updated_at=now() WHERE project_id=$1", [settings.projectId]);
  } catch (error) {
    await query("UPDATE project_git_settings SET last_sync_at=now(), last_sync_status='failed', updated_at=now() WHERE project_id=$1", [settings.projectId]);
    throw error;
  }
}

export async function offloadProject(settings: ProjectGitSettings, branch: string) {
  if (!settings.enabled) throw Object.assign(new Error("Project Git synchronization is disabled"), { statusCode: 409 });
  if (settings.syncMode === "mirror") {
    await assertSafeProviderResolution(settings.repositoryUrl);
    const directory = projectDirectory(settings.projectId);
    await ensureRemote(directory, settings);
    await git(directory, ["push", "vibeable", "--all"], settings);
    await query("UPDATE project_git_settings SET last_sync_at=now(), last_sync_status='success', updated_at=now() WHERE project_id=$1", [settings.projectId]);
  } else {
    await syncProjectGit(settings, branch, "push");
  }
  await rm(projectDirectory(settings.projectId), { recursive: true, force: true });
}

export async function restoreProjectFromGit(settings: ProjectGitSettings, branch: string) {
  await syncProjectGit(settings, branch, "pull");
}

export async function deleteProjectWorkspace(projectId: string) {
  await rm(projectDirectory(projectId), { recursive: true, force: true });
}

async function cloneProject(settings: ProjectGitSettings, branch: string) {
  const directory = projectDirectory(settings.projectId);
  await mkdir(dirname(directory), { recursive: true });
  await rm(directory, { recursive: true, force: true });
  await git(dirname(directory), ["clone", "--origin", "vibeable", "--branch", branch, "--single-branch", settings.repositoryUrl, directory], settings);
  await git(directory, ["config", "user.name", "Vibeable Agent"], settings);
  await git(directory, ["config", "user.email", "agent@vibeable.local"], settings);
}

async function ensureRemote(directory: string, settings: ProjectGitSettings) {
  const existing = await git(directory, ["remote", "get-url", "vibeable"], settings).catch(() => null);
  if (existing) await git(directory, ["remote", "set-url", "vibeable", settings.repositoryUrl], settings);
  else await git(directory, ["remote", "add", "vibeable", settings.repositoryUrl], settings);
}

async function refExists(directory: string, ref: string) {
  return Boolean(await git(directory, ["show-ref", "--verify", "--quiet", ref]).then(() => true).catch(() => false));
}

async function git(directory: string, args: string[], settings?: ProjectGitSettings) {
  return execFileAsync("git", ["-c", `core.hooksPath=${nullDevice}`, "-c", "core.fsmonitor=false", "-c", "http.followRedirects=false", ...args], {
    cwd: directory,
    timeout: 120_000,
    maxBuffer: 2_000_000,
    env: gitEnvironment(settings)
  });
}

function gitEnvironment(settings?: ProjectGitSettings) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: nullDevice, GIT_TERMINAL_PROMPT: "0"
  };
  if (!settings?.encryptedCredential) return environment;
  const credential = decryptSecret(settings.encryptedCredential);
  const authorization = settings.credentialType === "basic"
    ? `Basic ${Buffer.from(credential).toString("base64")}`
    : `Bearer ${credential}`;
  environment.GIT_CONFIG_COUNT = "1";
  environment.GIT_CONFIG_KEY_0 = "http.extraHeader";
  environment.GIT_CONFIG_VALUE_0 = `Authorization: ${authorization}`;
  return environment;
}

async function exists(path: string) { return Boolean(await stat(path).then(() => true).catch(() => false)); }
