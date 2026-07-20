import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyEdits, readContainedFile, workspaceContext } from "./workspace.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

describe("workspace boundaries", () => {
  it("writes ordinary nested files", async () => {
    const workspace = await temporaryDirectory("vibeable-workspace-");
    await applyEdits(workspace, [{ path: "src/index.ts", content: "export const ready = true;\n", summary: "Add entrypoint" }]);
    await expect(readFile(join(workspace, "src/index.ts"), "utf8")).resolves.toContain("ready = true");
  });

  it("rejects writes through a directory symlink", async () => {
    const workspace = await temporaryDirectory("vibeable-workspace-");
    const outside = await temporaryDirectory("vibeable-outside-");
    await symlink(outside, join(workspace, "linked"));
    await expect(applyEdits(workspace, [{ path: "linked/payload.txt", content: "escaped", summary: "Escape" }]))
      .rejects.toThrow("Unsafe workspace directory");
    await expect(readFile(join(outside, "payload.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects preview reads through symlinks and traversal", async () => {
    const workspace = await temporaryDirectory("vibeable-workspace-");
    const outside = await temporaryDirectory("vibeable-outside-");
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(workspace, "secret.txt"));
    await expect(readContainedFile(workspace, "secret.txt")).rejects.toMatchObject({ statusCode: 400 });
    await expect(readContainedFile(workspace, "../secret.txt")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("excludes common secret files from model context", async () => {
    const workspace = await temporaryDirectory("vibeable-workspace-");
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "index.ts"), "export {};\n");
    await writeFile(join(workspace, ".env.production"), "TOKEN=hidden\n");
    await writeFile(join(workspace, "credentials.json"), "{\"token\":\"hidden\"}\n");
    const context = await workspaceContext(workspace);
    expect(context).toContain("src/index.ts");
    expect(context).not.toContain("hidden");
  });
});
