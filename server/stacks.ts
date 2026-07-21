import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { z } from "zod";
import { query } from "./db.js";

const stringList = z.array(z.string().trim().min(1).max(200)).max(100).default([]);

export const stackRulesSchema = z.object({
  allowedLanguages: stringList,
  allowedFrameworks: stringList,
  allowedPackageManagers: stringList,
  allowedBaseImages: stringList,
  requiredFiles: stringList,
  requiredDependencies: stringList,
  forbiddenDependencies: stringList,
  requiredScripts: stringList
}).strict();

export type StackRules = z.infer<typeof stackRulesSchema>;

export interface StackProfile {
  id: string;
  name: string;
  description: string;
  scopeType: "global" | "team" | "project";
  scopeId: string;
  rules: StackRules;
  isDefault: boolean;
}

export async function resolveStackProfile(input: { organizationId: string; teamId: string; projectId: string }) {
  const result = await query<StackProfile>(
    `SELECT s.id, s.name, s.description, s.scope_type AS "scopeType", s.scope_id AS "scopeId",
            s.rules, s.is_default AS "isDefault"
       FROM projects p
       JOIN stack_profiles s ON s.organization_id=p.organization_id AND s.enabled=true
      WHERE p.id=$3 AND p.organization_id=$1 AND
        (s.id=p.stack_profile_id OR (p.stack_profile_id IS NULL AND s.is_default=true AND
          ((s.scope_type='project' AND s.scope_id=$3) OR (s.scope_type='team' AND s.scope_id=$2) OR
           (s.scope_type='global' AND s.scope_id=$1))))
      ORDER BY (s.id=p.stack_profile_id) DESC,
        CASE s.scope_type WHEN 'project' THEN 3 WHEN 'team' THEN 2 ELSE 1 END DESC
      LIMIT 1`,
    [input.organizationId, input.teamId, input.projectId]
  );
  const profile = result.rows[0];
  return profile ? { ...profile, rules: stackRulesSchema.parse(profile.rules) } : null;
}

export function stackProfilePrompt(profile: StackProfile | null) {
  if (!profile) return "No stack profile is enforced for this project.";
  return [
    `Enforced stack profile: ${profile.name}`,
    profile.description,
    `Rules: ${JSON.stringify(profile.rules)}`,
    "All generated files and dependencies must satisfy these rules. These constraints are validated after editing."
  ].filter(Boolean).join("\n");
}

export async function validateStackProfile(directory: string, profile: StackProfile | null) {
  if (!profile) return { ok: true, output: "No stack profile configured." };
  const files = await listFiles(directory);
  const errors: string[] = [];
  const rules = profile.rules;
  for (const required of rules.requiredFiles) {
    if (!files.includes(required)) errors.push(`Required file is missing: ${required}`);
  }
  if (rules.allowedLanguages.length) {
    const allowed = new Set(rules.allowedLanguages.map((value) => value.toLowerCase()));
    const detected = new Set(files.map(languageForFile).filter((value): value is string => Boolean(value)));
    for (const language of detected) if (!allowed.has(language)) errors.push(`Language is not allowed: ${language}`);
  }

  const packageJson = await readJson(join(directory, "package.json"));
  if (packageJson) {
    const dependencies = new Set([
      ...Object.keys(asRecord(packageJson.dependencies)), ...Object.keys(asRecord(packageJson.devDependencies))
    ]);
    for (const dependency of rules.requiredDependencies) if (!dependencies.has(dependency)) errors.push(`Required dependency is missing: ${dependency}`);
    for (const dependency of rules.forbiddenDependencies) if (dependencies.has(dependency)) errors.push(`Dependency is forbidden: ${dependency}`);
    const scripts = asRecord(packageJson.scripts);
    for (const script of rules.requiredScripts) if (!(script in scripts)) errors.push(`Required package script is missing: ${script}`);
    if (rules.allowedFrameworks.length) {
      const detected = detectFrameworks(dependencies);
      const allowed = new Set(rules.allowedFrameworks.map((value) => value.toLowerCase()));
      for (const framework of detected) if (framework && !allowed.has(framework)) errors.push(`Framework is not allowed: ${framework}`);
    }
    if (rules.allowedPackageManagers.length) {
      const manager = detectPackageManager(files, packageJson.packageManager);
      if (manager && !rules.allowedPackageManagers.map((value) => value.toLowerCase()).includes(manager)) {
        errors.push(`Package manager is not allowed: ${manager}`);
      }
    }
  } else if (rules.requiredDependencies.length || rules.requiredScripts.length || rules.allowedPackageManagers.length) {
    errors.push("A package.json is required by this stack profile");
  }

  if (rules.allowedBaseImages.length && files.includes("Dockerfile")) {
    const dockerfile = await readFile(join(directory, "Dockerfile"), "utf8");
    const allowed = rules.allowedBaseImages;
    for (const match of dockerfile.matchAll(/^\s*FROM\s+([^\s]+).*$/gim)) {
      const image = match[1]!;
      if (!allowed.some((prefix) => image === prefix || image.startsWith(`${prefix}:`) || image.startsWith(`${prefix}@`))) {
        errors.push(`Container base image is not allowed: ${image}`);
      }
    }
  }
  return { ok: errors.length === 0, output: errors.length ? errors.join("\n") : `Stack profile '${profile.name}' passed.` };
}

async function listFiles(directory: string, current = directory): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || ["node_modules", "dist"].includes(entry.name)) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(directory, path));
    else if (entry.isFile() && (await stat(path)).size <= 2_000_000) files.push(relative(directory, path));
  }
  return files.sort();
}

async function readJson(path: string) {
  try { return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; }
  catch { return null; }
}

function asRecord(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

function languageForFile(path: string) {
  const extension = extname(path).toLowerCase();
  return ({ ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript", ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".rb": "ruby", ".php": "php", ".cs": "csharp" } as Record<string, string>)[extension];
}

function detectFrameworks(dependencies: Set<string>) {
  const map: Record<string, string> = { react: "react", vue: "vue", svelte: "svelte", next: "next", express: "express", fastify: "fastify", "@nestjs/core": "nestjs", hono: "hono" };
  return [...new Set([...dependencies].map((dependency) => map[dependency]).filter(Boolean))];
}

function detectPackageManager(files: string[], declared: unknown) {
  if (typeof declared === "string") return declared.split("@")[0]!.toLowerCase();
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
  if (files.includes("package-lock.json")) return "npm";
  return null;
}
