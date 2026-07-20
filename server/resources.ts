import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { query, transaction } from "./db.js";
import { decryptSecret, encryptSecret } from "./security.js";

export type ResourceKind = "secret" | "api" | "smtp" | "database" | "git" | "service";

interface ResourceRow {
  id: string;
  kind: ResourceKind;
  name: string;
  environment: "development" | "staging" | "production" | "all";
  config: Record<string, unknown>;
  encryptedValue: string | null;
  updatedAt: string;
}

export async function listProjectResources(organizationId: string, projectId: string) {
  const result = await query<ResourceRow>(
    `SELECT id, kind, name, environment, config, encrypted_value AS "encryptedValue", updated_at AS "updatedAt"
       FROM project_resources WHERE organization_id=$1 AND project_id=$2 ORDER BY kind, name`,
    [organizationId, projectId]
  );
  return result.rows.map(({ encryptedValue, ...resource }) => ({ ...resource, configured: Boolean(encryptedValue) }));
}

export async function upsertProjectResource(input: {
  organizationId: string;
  projectId: string;
  userId: string;
  kind: Exclude<ResourceKind, "database">;
  name: string;
  environment: ResourceRow["environment"];
  value?: string;
  config?: Record<string, unknown>;
}) {
  const encryptedValue = input.value ? encryptSecret(input.value) : null;
  const result = await query<{ id: string }>(
    `INSERT INTO project_resources
      (organization_id, project_id, kind, name, environment, config, encrypted_value, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (project_id, name, environment) DO UPDATE SET
       kind=excluded.kind, config=excluded.config,
       encrypted_value=coalesce(excluded.encrypted_value, project_resources.encrypted_value), updated_at=now()
     RETURNING id`,
    [input.organizationId, input.projectId, input.kind, input.name, input.environment,
      input.config ?? {}, encryptedValue, input.userId]
  );
  return result.rows[0]!.id;
}

export async function deleteProjectResource(organizationId: string, projectId: string, resourceId: string) {
  return transaction(async (database) => {
    const resource = await database.query<Pick<ResourceRow, "kind" | "config">>(
      "SELECT kind, config FROM project_resources WHERE id=$1 AND project_id=$2 AND organization_id=$3 FOR UPDATE",
      [resourceId, projectId, organizationId]
    );
    const row = resource.rows[0];
    if (!row) return false;
    if (row.kind === "database" && row.config.managed === true) {
      const role = String(row.config.role ?? "");
      const schema = String(row.config.schema ?? "");
      if (role && schema) {
        await database.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND pid <> pg_backend_pid()", [role]);
        await database.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
        await database.query(`DROP OWNED BY ${quoteIdentifier(role)}`);
        await database.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
      }
    }
    await database.query("DELETE FROM project_resources WHERE id=$1", [resourceId]);
    return true;
  });
}

export async function provisionProjectDatabase(input: {
  organizationId: string;
  projectId: string;
  userId: string;
}) {
  const suffix = input.projectId.replaceAll("-", "").slice(0, 16);
  const role = `vibeable_app_${suffix}`;
  const schema = `app_${suffix}`;
  const password = randomBytes(24).toString("base64url");
  const databaseUrl = new URL(config.DATABASE_URL);
  const databaseName = databaseUrl.pathname.slice(1);
  databaseUrl.username = role;
  databaseUrl.password = password;
  databaseUrl.searchParams.set("options", `-csearch_path=${schema}`);

  return transaction(async (database) => {
    await database.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`vibeable:database:${input.projectId}`]);
    const existing = await database.query<{ id: string }>(
      `SELECT id FROM project_resources
        WHERE organization_id=$1 AND project_id=$2 AND kind='database' AND name='DATABASE_URL' AND environment='development'`,
      [input.organizationId, input.projectId]
    );
    if (existing.rows[0]) return existing.rows[0].id;
    await database.query(`DO $$ BEGIN CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD '${password}'; EXCEPTION WHEN duplicate_object THEN ALTER ROLE ${quoteIdentifier(role)} PASSWORD '${password}'; END $$`);
    await database.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)} AUTHORIZATION ${quoteIdentifier(role)}`);
    await database.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(role)}`);
    await database.query(`ALTER ROLE ${quoteIdentifier(role)} IN DATABASE ${quoteIdentifier(databaseName)} SET search_path TO ${quoteIdentifier(schema)}`);
    const result = await database.query<{ id: string }>(
      `INSERT INTO project_resources
        (organization_id, project_id, kind, name, environment, config, encrypted_value, created_by)
       VALUES ($1,$2,'database','DATABASE_URL','development',$3,$4,$5)
       ON CONFLICT (project_id, name, environment) DO UPDATE SET
         config=excluded.config, encrypted_value=excluded.encrypted_value, updated_at=now()
       RETURNING id`,
      [input.organizationId, input.projectId, { engine: "postgresql", database: databaseName, schema, role, managed: true },
        encryptSecret(databaseUrl.toString()), input.userId]
    );
    return result.rows[0]!.id;
  });
}

export async function projectCapabilityContext(organizationId: string, projectId: string) {
  const [resources, logs] = await Promise.all([
    query<ResourceRow>(
      `SELECT id, kind, name, environment, config, encrypted_value AS "encryptedValue", updated_at AS "updatedAt"
         FROM project_resources WHERE organization_id=$1 AND project_id=$2 ORDER BY kind, name`,
      [organizationId, projectId]
    ),
    query<{ source: string; level: string; message: string; createdAt: string }>(
      `SELECT source, level, message, created_at AS "createdAt" FROM project_runtime_logs
        WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 40`,
      [organizationId, projectId]
    )
  ]);
  const manifest = resources.rows.map((resource) => ({
    kind: resource.kind,
    name: resource.name,
    environment: resource.environment,
    configured: Boolean(resource.encryptedValue),
    config: resource.config
  }));
  const recentLogs = [...logs.rows].reverse();
  return {
    manifest,
    recentLogs,
    prompt: [
      "Project capability manifest (values are injected at runtime; never hard-code or request secret values):",
      manifest.length ? JSON.stringify(manifest, null, 2) : "No project resources configured.",
      "Recent preview/build logs:",
      recentLogs.length ? recentLogs.map((log) => `[${log.source}/${log.level}] ${log.message}`).join("\n") : "No runtime logs captured yet."
    ].join("\n")
  };
}

export async function projectRuntimeEnvironment(organizationId: string, projectId: string, environment = "development") {
  const result = await query<Pick<ResourceRow, "name" | "environment" | "encryptedValue"> & { kind: ResourceKind }>(
    `SELECT name, kind, environment, encrypted_value AS "encryptedValue" FROM project_resources
      WHERE organization_id=$1 AND project_id=$2 AND encrypted_value IS NOT NULL
        AND environment IN ($3, 'all')
      ORDER BY CASE WHEN environment='all' THEN 0 ELSE 1 END`,
    [organizationId, projectId, environment]
  );
  return Object.fromEntries(result.rows.map((resource) => [resource.name, decryptSecret(resource.encryptedValue!)]));
}

export async function projectPreviewOrigins(organizationId: string, projectId: string) {
  const result = await query<Pick<ResourceRow, "config">>(
    `SELECT config FROM project_resources
      WHERE organization_id=$1 AND project_id=$2 AND kind IN ('api', 'service')`,
    [organizationId, projectId]
  );
  const origins = new Set<string>();
  for (const row of result.rows) {
    for (const [key, value] of Object.entries(row.config)) {
      if (typeof value !== "string" || !/url$/i.test(key)) continue;
      try {
        const url = new URL(value);
        if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) origins.add(url.origin);
      } catch {
        // Resource validation normally prevents malformed URL metadata.
      }
    }
  }
  return [...origins].sort();
}

export async function recordProjectLog(input: {
  organizationId: string;
  projectId: string;
  runId?: string;
  source: "preview" | "build" | "agent" | "system";
  level: "debug" | "info" | "warn" | "error";
  message: string;
}) {
  const secrets = await query<{ encryptedValue: string }>(
    `SELECT encrypted_value AS "encryptedValue" FROM project_resources
      WHERE organization_id=$1 AND project_id=$2 AND encrypted_value IS NOT NULL`,
    [input.organizationId, input.projectId]
  );
  const message = secrets.rows.reduce((output, row) => redactSecret(output, decryptSecret(row.encryptedValue)), input.message);
  await query(
    `INSERT INTO project_runtime_logs (organization_id,project_id,run_id,source,level,message)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [input.organizationId, input.projectId, input.runId ?? null, input.source, input.level, message.slice(0, 4000)]
  );
}

function redactSecret(message: string, secret: string) {
  if (!secret) return message;
  let output = message.replaceAll(secret, "[redacted]");
  try {
    const url = new URL(secret);
    for (const credential of [url.username, url.password]) {
      if (credential.length >= 4) output = output.replaceAll(credential, "[redacted]");
    }
  } catch {
    // Most secrets are opaque tokens rather than URLs.
  }
  return output;
}

function quoteIdentifier(value: string) {
  if (!value || value.includes("\0") || Buffer.byteLength(value, "utf8") > 63) throw new Error("Unsafe PostgreSQL identifier");
  return `"${value.replaceAll('"', '""')}"`;
}
