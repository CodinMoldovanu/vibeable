import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);
const MAX_CONTEXT_BYTES = 120_000;
const ignored = new Set([".git", "node_modules", "dist"]);
const sensitiveNames = /(?:^\.env(?:\.|$)|\.pem$|\.key$|^id_(?:rsa|dsa|ecdsa|ed25519)$|credentials|secrets?)/i;

export function projectDirectory(projectId: string) {
  return join(config.DATA_DIR, "projects", projectId);
}

export async function ensureWorkspace(projectId: string, projectName: string) {
  const directory = projectDirectory(projectId);
  await mkdir(directory, { recursive: true });
  const indexPath = join(directory, "index.html");
  try {
    await stat(indexPath);
  } catch {
    await writeFile(indexPath, starterHtml(projectName), { encoding: "utf8", flag: "wx" });
  }
  const gitignorePath = join(directory, ".gitignore");
  try {
    await stat(gitignorePath);
  } catch {
    await writeFile(gitignorePath, ".env\n.env.*\nnode_modules\ndist\n", { encoding: "utf8", flag: "wx" });
  }
  await initializeRepository(directory);
  return directory;
}

export async function prepareRunBranch(directory: string, runId: string) {
  await initializeRepository(directory);
  await git(directory, ["checkout", "main"]);
  await git(directory, ["reset", "--hard", "HEAD"]);
  await git(directory, ["clean", "-fd"]);
  await git(directory, ["checkout", "-B", `agent/${runId}`]);
}

export async function commitRun(directory: string, input: { runId: string; userId: string; providerId: string; model: string; totalTokens: number }) {
  await git(directory, ["add", "-A"]);
  const status = await git(directory, ["status", "--porcelain"]);
  if (status.stdout.trim()) {
    await git(directory, [
      "commit",
      "-m", `Agent run ${input.runId.slice(0, 8)}`,
      "-m", `Run-Id: ${input.runId}\nUser-Id: ${input.userId}\nProvider-Id: ${input.providerId}\nModel: ${input.model}\nTotal-Tokens: ${input.totalTokens}`
    ]);
  }
  return (await git(directory, ["rev-parse", "HEAD"])).stdout.trim();
}

export async function finalizeRunBranch(directory: string, runId: string) {
  await git(directory, ["checkout", "main"]);
  await git(directory, ["merge", "--ff-only", `agent/${runId}`]);
}

export async function abortRunBranch(directory: string, runId: string) {
  await git(directory, ["reset", "--hard", "HEAD"]).catch(() => undefined);
  await git(directory, ["checkout", "main"]).catch(() => undefined);
  await git(directory, ["branch", "-D", `agent/${runId}`]).catch(() => undefined);
}

export async function workspaceContext(directory: string) {
  const paths = await walk(directory);
  let total = 0;
  const chunks: string[] = [];
  for (const path of paths) {
    const size = (await stat(path)).size;
    if (size > 50_000 || total + size > MAX_CONTEXT_BYTES) continue;
    const content = await readFile(path, "utf8").catch(() => null);
    if (content === null || content.includes("\0")) continue;
    total += size;
    chunks.push(`--- ${relative(directory, path)} ---\n${content}`);
  }
  return chunks.join("\n\n");
}

export async function applyEdits(directory: string, files: Array<{ path: string; content: string; summary: string }>) {
  const root = await realpath(directory);
  const changes: Array<{ path: string; additions: number; deletions: number; summary: string }> = [];
  for (const file of files) {
    const destination = resolve(root, file.path);
    const segments = relative(root, destination).split(sep);
    if (!isContained(root, destination) || segments.some((segment) => !segment || segment === "." || segment === "..") || file.path.includes("\0")) {
      throw new Error(`Unsafe generated path: ${file.path}`);
    }
    await ensureSafeParent(root, segments.slice(0, -1));
    const target = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (target?.isSymbolicLink() || target?.isDirectory()) throw new Error(`Unsafe generated path: ${file.path}`);
    const before = await readFile(destination, "utf8").catch(() => "");
    await writeFile(destination, file.content, "utf8");
    changes.push({
      path: file.path,
      additions: countChangedLines(before, file.content),
      deletions: countChangedLines(file.content, before),
      summary: file.summary
    });
  }
  return changes;
}

export async function verifyWorkspace(directory: string) {
  if (config.EXECUTION_MODE === "disabled") {
    return { ok: true, output: "Execution disabled; file safety checks passed." };
  }
  const packageJson = await readFile(join(directory, "package.json"), "utf8").catch(() => null);
  if (!packageJson) return { ok: true, output: "Static workspace ready." };
  const command = "corepack pnpm install --frozen-lockfile --ignore-scripts && corepack pnpm run build";
  if (config.EXECUTION_MODE === "docker") {
    const { stdout, stderr } = await execFileAsync("docker", [
      "run", "--rm", "--network", "none", "--cpus", "2", "--memory", "1g", "--pids-limit", "256",
      "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "-v", `${directory}:/workspace`, "-w", "/workspace",
      "node:22-alpine", "sh", "-lc", command
    ], { timeout: 300_000, maxBuffer: 2_000_000 });
    return { ok: true, output: `${stdout}\n${stderr}`.trim() };
  }
  const { stdout, stderr } = await execFileAsync("sh", ["-lc", command], {
    cwd: directory,
    timeout: 300_000,
    maxBuffer: 2_000_000
  });
  return { ok: true, output: `${stdout}\n${stderr}`.trim() };
}

export async function readPreview(projectId: string, requestedPath = "index.html") {
  return readContainedFile(projectDirectory(projectId), requestedPath);
}

export async function readContainedFile(directory: string, requestedPath = "index.html") {
  const root = await realpath(directory);
  const destination = resolve(root, requestedPath || "index.html");
  if (!isContained(root, destination)) {
    throw Object.assign(new Error("Invalid preview path"), { statusCode: 400 });
  }
  const target = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw Object.assign(new Error("Preview file not found"), { statusCode: 404 });
    throw error;
  });
  if (target.isSymbolicLink() || !target.isFile()) throw Object.assign(new Error("Invalid preview path"), { statusCode: 400 });
  const resolvedTarget = await realpath(destination);
  if (!isContained(root, resolvedTarget)) throw Object.assign(new Error("Invalid preview path"), { statusCode: 400 });
  return readFile(resolvedTarget);
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (ignored.has(entry.name) || sensitiveNames.test(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

async function ensureSafeParent(root: string, segments: string[]) {
  let current = root;
  for (const segment of segments) {
    const next = join(current, segment);
    const existing = await lstat(next).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!existing) await mkdir(next);
    else if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(`Unsafe workspace directory: ${segment}`);
    current = next;
  }
}

function isContained(root: string, candidate: string) {
  return candidate.startsWith(`${root}${sep}`);
}

async function initializeRepository(directory: string) {
  const repository = await stat(join(directory, ".git")).catch(() => null);
  if (repository?.isDirectory()) return;
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.name", "Vibeable Agent"]);
  await git(directory, ["config", "user.email", "agent@vibeable.local"]);
  await git(directory, ["add", "-A"]);
  await git(directory, ["commit", "-m", "Initialize Vibeable project"]);
}

async function git(directory: string, args: string[]) {
  return execFileAsync("git", args, { cwd: directory, timeout: 30_000, maxBuffer: 2_000_000 });
}

function countChangedLines(left: string, right: string) {
  const baseline = new Set(left.split("\n"));
  return right.split("\n").filter((line) => !baseline.has(line)).length;
}

function starterHtml(name: string) {
  const safeName = name.replace(/[<>&"']/g, "");
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeName}</title><style>body{font:16px system-ui;margin:0;background:#f4f6f8;color:#18212f}main{max-width:880px;margin:12vh auto;padding:32px}h1{font-size:42px;margin:0 0 12px}p{color:#52606d}</style></head>
<body><main><h1>${safeName}</h1><p>Your Vibeable workspace is ready. Ask the agent to build the first version.</p></main></body></html>`;
}
