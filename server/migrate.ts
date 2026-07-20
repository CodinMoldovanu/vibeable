import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

export async function migrate(databasePool: Pool, migrationsDirectory = join(process.cwd(), "server", "migrations")) {
  const client = await databasePool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('vibeable:migrations'))");
    locked = true;
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text, applied_at timestamptz NOT NULL DEFAULT now())");
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text");
    const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      const sql = await readFile(join(migrationsDirectory, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string | null }>("SELECT checksum FROM schema_migrations WHERE version = $1", [file]);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum && existing.rows[0].checksum !== checksum) {
          throw new Error(`Applied migration ${file} has changed`);
        }
        if (!existing.rows[0].checksum) await client.query("UPDATE schema_migrations SET checksum = $2 WHERE version = $1", [file, checksum]);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    await client.query("ALTER TABLE schema_migrations ALTER COLUMN checksum SET NOT NULL");
    return files;
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('vibeable:migrations'))").catch(() => undefined);
    client.release();
  }
}
