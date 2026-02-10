const { Pool } = require("pg");

/**
 * pg uses standard env vars:
 *  PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
 * Optional:
 *  DATABASE_URL (connection string)
 */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  max: Number(process.env.PGPOOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PGPOOL_CONN_TIMEOUT_MS || 5000),
});

pool.on("error", (err) => {
  // Prevent silent pool crashes; surface the issue clearly.
  console.error("[db] Unexpected idle client error:", err);
});

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };

