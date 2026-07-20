import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);
const MAX_CONTEXT_BYTES = 120_000;
const ignored = new Set([".git", "node_modules", "dist", ".env"]);

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
  return directory;
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
  const changes: Array<{ path: string; additions: number; deletions: number; summary: string }> = [];
  for (const file of files) {
    const destination = resolve(directory, file.path);
    if (!destination.startsWith(`${resolve(directory)}${sep}`) || file.path.includes("..") || file.path.startsWith("/")) {
      throw new Error(`Unsafe generated path: ${file.path}`);
    }
    const before = await readFile(destination, "utf8").catch(() => "");
    await mkdir(dirname(destination), { recursive: true });
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
  const directory = projectDirectory(projectId);
  const destination = resolve(directory, requestedPath || "index.html");
  if (!destination.startsWith(`${resolve(directory)}${sep}`) && destination !== join(resolve(directory), "index.html")) {
    throw Object.assign(new Error("Invalid preview path"), { statusCode: 400 });
  }
  return readFile(destination);
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
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
