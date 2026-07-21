import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDeploymentPlan, parseDeploymentConfig } from "./deployment-worker.js";
import { assertGitBranch } from "./project-git.js";

describe("delivery input boundaries", () => {
  it("accepts normal branches and rejects option or ref injection", () => {
    expect(assertGitBranch("feature/checkout-v2")).toBe("feature/checkout-v2");
    for (const branch of ["--upload-pack=evil", "feature/../main", "main @{1}", "bad:ref"]) {
      expect(() => assertGitBranch(branch)).toThrow("Invalid Git branch name");
    }
  });

  it("uses strict adapter schemas without arbitrary commands or escaping paths", () => {
    expect(parseDeploymentConfig("helm", { chartPath: "deploy/chart", release: "app", namespace: "prod" })).toEqual(expect.objectContaining({ release: "app" }));
    expect(() => parseDeploymentConfig("compose", { composePath: "../compose.yml" })).toThrow();
    expect(() => parseDeploymentConfig("kubernetes", { manifestPath: "deploy.yml", command: "curl evil" })).toThrow();
    expect(() => parseDeploymentConfig("kubernetes", { manifestPath: "deploy.yml", namespace: "--kubeconfig=stolen" })).toThrow();
  });

  it("rejects deployment files reached through an intermediate workspace symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibeable-deploy-root-"));
    const outside = await mkdtemp(join(tmpdir(), "vibeable-deploy-outside-"));
    try {
      await mkdir(join(outside, "manifests"));
      await writeFile(join(outside, "manifests", "app.yml"), "kind: Deployment\n");
      await symlink(join(outside, "manifests"), join(directory, "deploy"));
      await expect(buildDeploymentPlan({
        adapter: "kubernetes",
        config: { manifestPath: "deploy/app.yml" },
        directory,
        branch: "main",
        commitSha: "a".repeat(40)
      })).rejects.toThrow("symbolic link");
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
