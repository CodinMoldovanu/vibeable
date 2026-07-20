import { pool } from "../db.js";
import { migrate } from "../migrate.js";

try {
  const files = await migrate(pool);
  process.stdout.write(`Database is current (${files.length} migration(s)).\n`);
} finally {
  await pool.end();
}
