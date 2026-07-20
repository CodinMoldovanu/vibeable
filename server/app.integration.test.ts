import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate } from "./migrate.js";
import type { FastifyInstance } from "fastify";

let database: EmbeddedPostgres;
let app: FastifyInstance;
let databasePool: Pool;
let dataDirectory: string;
let ownerCookie: string;
let defaultTeamId: string;
let secondTeamId: string;
let defaultProjectId: string;
let secondProjectId: string;
let developerId: string;
let developerCookie: string;
let reviewerId: string;
let reviewerCookie: string;

const csrf = { "x-vibeable-csrf": "1" };

describe("PostgreSQL API integration", () => {
  beforeAll(async () => {
    const port = await availablePort();
    dataDirectory = await mkdtemp(join(tmpdir(), "vibeable-integration-"));
    database = new EmbeddedPostgres({
      databaseDir: join(dataDirectory, "postgres"),
      user: "vibeable",
      password: "integration-password",
      port,
      persistent: false,
      onLog: () => undefined,
      onError: () => undefined
    });
    await database.initialise();
    await database.start();
    await database.createDatabase("vibeable_test");
    const databaseUrl = `postgres://vibeable:integration-password@127.0.0.1:${port}/vibeable_test`;
    databasePool = new Pool({ connectionString: databaseUrl });
    const firstRun = await migrate(databasePool);
    const secondRun = await migrate(databasePool);
    expect(firstRun).toEqual(secondRun);

    process.env.NODE_ENV = "test";
    process.env.LOG_LEVEL = "silent";
    process.env.DATABASE_URL = databaseUrl;
    process.env.DATA_DIR = join(dataDirectory, "workspaces");
    process.env.MASTER_KEY = "integration-test-master-key-with-adequate-entropy";
    process.env.PUBLIC_URL = "http://127.0.0.1:8787";
    process.env.REQUIRE_SEPARATE_APPROVER = "true";
    const module = await import("./app.js");
    app = module.buildApp();
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app?.close();
    const dbModule = await import("./db.js");
    await dbModule.pool.end();
    await databasePool?.end();
    await database?.stop();
    if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
  }, 30_000);

  it("bootstraps one owner and refuses a second bootstrap", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      payload: {
        organizationName: "Vibeable Test",
        name: "Owner User",
        email: "owner@example.test",
        password: "owner-password-123",
        providerUrl: "https://openrouter.ai/api/v1",
        providerModel: "test/model"
      }
    });
    expect(response.statusCode).toBe(201);
    ownerCookie = sessionCookie(response.headers["set-cookie"]);
    expect(ownerCookie).toContain("vibeable_session=");
    const duplicate = await app.inject({ method: "POST", url: "/api/auth/bootstrap", payload: {
      organizationName: "Other", name: "Other Owner", email: "other@example.test", password: "owner-password-456"
    } });
    expect(duplicate.statusCode).toBe(409);
  });

  it("creates isolated teams, projects, and member roles", async () => {
    const teamsBefore = await authenticated("GET", "/api/admin/teams", ownerCookie);
    defaultTeamId = teamsBefore.json().teams[0].id as string;
    const teamResponse = await authenticated("POST", "/api/admin/teams", ownerCookie, { name: "Other Team" });
    expect(teamResponse.statusCode).toBe(201);
    secondTeamId = teamResponse.json().id as string;

    defaultProjectId = (await authenticated("POST", "/api/projects", ownerCookie, { name: "Default App", teamId: defaultTeamId })).json().id as string;
    secondProjectId = (await authenticated("POST", "/api/projects", ownerCookie, { name: "Other App", teamId: secondTeamId })).json().id as string;
    developerId = (await authenticated("POST", "/api/admin/users", ownerCookie, {
      name: "Developer User", email: "developer@example.test", password: "developer-password-123", role: "developer", teamId: defaultTeamId
    })).json().id as string;
    reviewerId = (await authenticated("POST", "/api/admin/users", ownerCookie, {
      name: "Reviewer User", email: "reviewer@example.test", password: "reviewer-password-123", role: "reviewer", teamId: defaultTeamId
    })).json().id as string;
    developerCookie = await login("developer@example.test", "developer-password-123");
    reviewerCookie = await login("reviewer@example.test", "reviewer-password-123");

    const developerProjects = await authenticated("GET", "/api/projects", developerCookie);
    expect(developerProjects.json().projects.map((project: { id: string }) => project.id)).toEqual([defaultProjectId]);
    expect((await authenticated("GET", `/api/projects/${secondProjectId}/deployments`, developerCookie)).statusCode).toBe(404);
    expect((await authenticated("POST", "/api/admin/memberships", ownerCookie, {
      userId: developerId, teamId: secondTeamId, role: "developer"
    })).statusCode).toBe(201);
    const expandedProjects = await authenticated("GET", "/api/projects", developerCookie);
    expect(expandedProjects.json().projects.map((project: { id: string }) => project.id).sort()).toEqual([defaultProjectId, secondProjectId].sort());
  });

  it("enforces metric scope membership", async () => {
    const reviewerScopes = (await authenticated("GET", "/api/metrics/scopes", reviewerCookie)).json().scopes as Array<{ scope: string; id: string }>;
    expect(reviewerScopes).toContainEqual(expect.objectContaining({ scope: "team", id: defaultTeamId }));
    expect(reviewerScopes).not.toContainEqual(expect.objectContaining({ scope: "team", id: secondTeamId }));
    expect((await authenticated("GET", `/api/metrics/usage?scope=team&id=${secondTeamId}`, reviewerCookie)).statusCode).toBe(403);
    expect((await authenticated("GET", `/api/metrics/usage?scope=project&id=${secondProjectId}`, reviewerCookie)).statusCode).toBe(404);
    expect((await authenticated("GET", `/api/metrics/usage?scope=user&id=${reviewerId}`, developerCookie)).statusCode).toBe(403);
    expect((await authenticated("GET", `/api/metrics/usage?scope=user&id=${developerId}`, developerCookie)).statusCode).toBe(200);
  });

  it("requires an independent reviewer for governed runs and production deployments", async () => {
    const providers = (await authenticated("GET", "/api/admin/providers", ownerCookie)).json().providers;
    const provider = providers[0] as { id: string; defaultModel: string };
    await authenticated("POST", "/api/admin/policies", ownerCookie, {
      scopeType: "global",
      scopeId: (await authenticated("GET", "/api/session", ownerCookie)).json().user.organizationId,
      defaultProviderId: provider.id,
      defaultModel: provider.defaultModel,
      allowedProviderIds: [provider.id],
      allowedModels: [provider.defaultModel],
      monthlyTokenLimit: 1_000_000,
      monthlyCostLimitUsd: 100,
      allowUserOverride: true,
      requireApprovalFor: ["agent:before_edit"]
    });
    const runResponse = await authenticated("POST", `/api/projects/${defaultProjectId}/runs`, developerCookie, {
      prompt: "Create a governed page", phase: "agent:before_edit"
    });
    expect(runResponse.statusCode).toBe(202);
    expect(runResponse.json().status).toBe("waiting_approval");
    const runId = runResponse.json().id as string;
    expect((await authenticated("POST", `/api/runs/${runId}/approve`, developerCookie)).statusCode).toBe(403);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        summary: "Built by integration test",
        files: [{ path: "index.html", content: "<!doctype html><title>Integrated</title><h1>Integrated</h1>", summary: "Build test page" }]
      }) } }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
    }), { status: 200, headers: { "content-type": "application/json" } })));
    expect((await authenticated("POST", `/api/runs/${runId}/approve`, reviewerCookie)).statusCode).toBe(200);
    await expect.poll(async () => {
      const runs = (await authenticated("GET", `/api/projects/${defaultProjectId}/runs`, developerCookie)).json().runs as Array<{ id: string; status: string }>;
      return runs.find((run) => run.id === runId)?.status;
    }, { timeout: 10_000 }).toBe("ready");
    const completedRun = ((await authenticated("GET", `/api/projects/${defaultProjectId}/runs`, developerCookie)).json().runs as Array<{ id: string; commitSha: string; totalTokens: number }>).find((run) => run.id === runId);
    expect(completedRun?.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(completedRun?.totalTokens).toBe(20);
    const preview = await authenticated("GET", `/api/projects/${defaultProjectId}/preview/index.html`, developerCookie);
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["cache-control"]).toBe("private, no-store");
    expect(preview.body).toContain("Integrated");
    expect(preview.body).toContain("vibeable-preview");
    const projectUsage = (await authenticated("GET", `/api/metrics/usage?scope=project&id=${defaultProjectId}`, developerCookie)).json().usage;
    expect(projectUsage).toEqual([expect.objectContaining({ model: "test/model", totalTokens: 20, requests: 1 })]);

    const deployment = await authenticated("POST", `/api/projects/${defaultProjectId}/deployments`, ownerCookie, { environment: "production" });
    const deploymentId = deployment.json().id as string;
    expect(deployment.json().status).toBe("waiting_approval");
    expect((await authenticated("POST", `/api/deployments/${deploymentId}/approve`, ownerCookie)).statusCode).toBe(409);
    expect((await authenticated("POST", `/api/deployments/${deploymentId}/approve`, reviewerCookie)).statusCode).toBe(200);

    const otherDeployment = await authenticated("POST", `/api/projects/${secondProjectId}/deployments`, ownerCookie, { environment: "production" });
    expect(otherDeployment.statusCode).toBe(201);
    expect((await authenticated("POST", `/api/deployments/${otherDeployment.json().id}/approve`, reviewerCookie)).statusCode).toBe(404);
  }, 20_000);

  it("edits providers without exposing or clearing stored API keys", async () => {
    const created = await authenticated("POST", "/api/admin/providers", ownerCookie, {
      name: "Editable provider", baseUrl: "https://example.test/v1", apiKey: "provider-secret-value",
      defaultModel: "example/model", allowedModels: ["example/model"], inputCostPerMillion: 1, outputCostPerMillion: 2
    });
    expect(created.statusCode).toBe(201);
    const providerId = created.json().id as string;
    const updated = await authenticated("PATCH", `/api/admin/providers/${providerId}`, ownerCookie, {
      name: "Edited provider", baseUrl: "https://example.test/api/v1", defaultModel: "example/model",
      allowedModels: ["example/model"], inputCostPerMillion: 1.5, outputCostPerMillion: 2.5, enabled: true
    });
    expect(updated.statusCode).toBe(200);
    const providers = (await authenticated("GET", "/api/admin/providers", ownerCookie)).json().providers as Array<Record<string, unknown>>;
    expect(providers.find((provider) => provider.id === providerId)).toEqual(expect.objectContaining({
      name: "Edited provider", hasApiKey: true, baseUrl: "https://example.test/api/v1"
    }));
    expect(JSON.stringify(providers)).not.toContain("provider-secret-value");
  });

  it("manages project capabilities and redacts secrets from runtime logs", async () => {
    const resource = await authenticated("POST", `/api/projects/${defaultProjectId}/resources`, ownerCookie, {
      kind: "api", name: "PAYMENTS_API_KEY", environment: "development", value: "top-secret-payment-token", config: { url: "https://payments.example.test/v1" }
    });
    expect(resource.statusCode).toBe(201);
    const configuredPreview = await authenticated("GET", `/api/projects/${defaultProjectId}/preview/index.html`, ownerCookie);
    expect(configuredPreview.headers["content-security-policy"]).toContain("https://payments.example.test");
    expect(configuredPreview.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
    const log = await authenticated("POST", `/api/projects/${defaultProjectId}/logs`, ownerCookie, {
      level: "error", message: "Request failed with top-secret-payment-token"
    });
    expect(log.statusCode).toBe(202);
    const logs = (await authenticated("GET", `/api/projects/${defaultProjectId}/logs`, ownerCookie)).json().logs as Array<{ message: string }>;
    expect(logs[0]?.message).toBe("Request failed with [redacted]");
    const resources = (await authenticated("GET", `/api/projects/${defaultProjectId}/resources`, ownerCookie)).json().resources;
    expect(resources).toEqual(expect.arrayContaining([expect.objectContaining({ name: "PAYMENTS_API_KEY", configured: true })]));
    expect(JSON.stringify(resources)).not.toContain("top-secret-payment-token");

    const firstDatabase = await authenticated("POST", `/api/projects/${defaultProjectId}/resources/database`, ownerCookie);
    const secondDatabase = await authenticated("POST", `/api/projects/${defaultProjectId}/resources/database`, ownerCookie);
    expect(firstDatabase.statusCode).toBe(201);
    expect(secondDatabase.json().id).toBe(firstDatabase.json().id);
    const withDatabase = (await authenticated("GET", `/api/projects/${defaultProjectId}/resources`, ownerCookie)).json().resources as Array<{ id: string; kind: string; config: { role?: string } }>;
    const databaseResource = withDatabase.find((item) => item.id === firstDatabase.json().id)!;
    expect(databaseResource.config.role).toMatch(/^vibeable_app_/);

    const unsafeGit = await authenticated("POST", `/api/projects/${defaultProjectId}/resources`, ownerCookie, {
      kind: "git", name: "SOURCE_REPOSITORY", environment: "development", config: { repositoryUrl: "https://token@example.test/repo.git" }
    });
    expect(unsafeGit.statusCode).toBe(400);
    expect((await authenticated("DELETE", `/api/projects/${defaultProjectId}/resources/${databaseResource.id}`, ownerCookie)).statusCode).toBe(200);
    const removedRole = await databasePool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [databaseResource.config.role]);
    expect(removedRole.rowCount).toBe(0);
    expect((await authenticated("DELETE", `/api/projects/${defaultProjectId}/resources/${resource.json().id}`, ownerCookie)).statusCode).toBe(200);
  });
});

async function authenticated(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie: string, payload?: Record<string, unknown>) {
  return app.inject({ method, url, headers: { cookie, ...(!["GET", "HEAD"].includes(method) ? csrf : {}) }, payload });
}

async function login(email: string, password: string) {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response.headers["set-cookie"]);
}

function sessionCookie(value: string | string[] | undefined) {
  const header = Array.isArray(value) ? value[0] : value;
  return header?.split(";")[0] ?? "";
}

async function availablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
