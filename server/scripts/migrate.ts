import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pool, transaction } from "../db.js";

const migrationsDir = join(process.cwd(), "server", "migrations");

await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

for (const file of files) {
  const exists = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
  if (exists.rowCount) continue;
  const sql = await readFile(join(migrationsDir, file), "utf8");
  await transaction(async (client) => {
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
  });
  process.stdout.write(`Applied ${file}\n`);
}

await pool.end();
