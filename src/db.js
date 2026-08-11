/*
 * PostgreSQL connection.
 *
 * The provider does not matter — Neon, Supabase, Railway, or a local
 * Postgres all work. Set one environment variable:
 *
 *     DATABASE_URL=postgresql://user:pass@host/dbname?sslmode=require
 *
 * On startup we apply db/schema.sql, which is written to be safe to re-run,
 * so a fresh database sets itself up with no manual step.
 */
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const CONNECTION_STRING = process.env.DATABASE_URL || "";

if (!CONNECTION_STRING) {
  console.error("\n ! DATABASE_URL is not set.");
  console.error("   Set it to your Postgres connection string, e.g.");
  console.error("   DATABASE_URL=postgresql://user:pass@host/db?sslmode=require\n");
}

// Managed Postgres (Neon/Supabase/Render) requires TLS; local usually doesn't.
const needsSsl = /sslmode=require/i.test(CONNECTION_STRING) ||
                 /neon\.tech|supabase\.|render\.com|railway\./i.test(CONNECTION_STRING);

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 5,                       // small pool: free tiers cap connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

pool.on("error", (err) => console.error(" ! unexpected postgres error:", err.message));

/** Run a query. Returns the rows. */
async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

/** Run a query expecting at most one row. Returns the row or null. */
async function one(text, params) {
  const rows = await query(text, params);
  return rows.length ? rows[0] : null;
}

/** Run several statements in a transaction. fn receives a client. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Apply db/schema.sql. Safe to run on every startup. */
async function init() {
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  await pool.query(sql);
}

/** Simple key/value settings (used for the session secret). */
async function getSetting(key) {
  const row = await one("SELECT value FROM settings WHERE key = $1", [key]);
  return row ? row.value : null;
}
async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]);
}

module.exports = { pool, query, one, tx, init, getSetting, setSetting };
