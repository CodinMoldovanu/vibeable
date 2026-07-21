import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateStackProfile, type StackProfile } from "./stacks.js";

let directory = "";
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe("stack profile validation", () => {
  it("enforces languages, dependencies, scripts, files, and container images", async () => {
    directory = await mkdtemp(join(tmpdir(), "vibeable-stack-"));
    await writeFile(join(directory, "index.ts"), "export const value = 1;\n");
    await writeFile(join(directory, "package.json"), JSON.stringify({
      packageManager: "pnpm@10.0.0", dependencies: { react: "19.0.0", "left-pad": "1.3.0" }, scripts: { dev: "vite" }
    }));
    await writeFile(join(directory, "Dockerfile"), "FROM node:22-alpine\n");
    const profile: StackProfile = {
      id: "profile", name: "Approved web", description: "", scopeType: "team", scopeId: "team", isDefault: true,
      rules: {
        allowedLanguages: ["typescript"], allowedFrameworks: ["react"], allowedPackageManagers: ["pnpm"],
        allowedBaseImages: ["node"], requiredFiles: ["Dockerfile"], requiredDependencies: ["react"],
        forbiddenDependencies: ["left-pad"], requiredScripts: ["build"]
      }
    };
    const result = await validateStackProfile(directory, profile);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Dependency is forbidden: left-pad");
    expect(result.output).toContain("Required package script is missing: build");
  });
});
