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

/* ── connection-string sanity check ───────────────────────
 * A malformed DATABASE_URL surfaces as `getaddrinfo ENOTFOUND <fragment>`,
 * which reads like a network fault and sends you looking in the wrong place.
 * It is almost always a paste problem instead. This turns the guesswork into
 * a specific sentence, and is called at startup BEFORE we try to connect so
 * the service fails in seconds rather than on a port-scan timeout.
 *
 * Returns an array of problems; empty means it looks usable.
 */
function checkConnectionString(raw = CONNECTION_STRING) {
  const s = String(raw || "");
  const problems = [];
  if (!s.trim()) return ["DATABASE_URL is empty or not set."];

  if (/^\s|\s$/.test(s)) problems.push("It has leading or trailing whitespace — trim it.");
  if (/[\r\n]/.test(s)) problems.push("It contains a line break: the value was pasted across two lines.");
  if (/^["']|["']$/.test(s.trim())) problems.push("It is wrapped in quotes — Render stores the value literally, so remove them.");
  // Copying the whole shell line is the single most common mistake, and it
  // looks different in every shell. Catch all of them, not just the bare key.
  //   PowerShell:  $env:DATABASE_URL="postgres://..."
  //   bash/zsh:    export DATABASE_URL=postgres://...
  //   cmd:         set DATABASE_URL=postgres://...
  const shellPrefix = s.trim().match(/^(\$env:|export\s+|set\s+|SET\s+)?([A-Z_][A-Z0-9_]*)\s*=/i);
  if (shellPrefix) {
    problems.push(`It starts with '${shellPrefix[0].trim()}' — that is shell syntax for setting the ` +
                  "variable. Render wants only the value: everything after the '=', without quotes.");
  }
  if (/^\s*psql\b/i.test(s)) problems.push("This is a psql command, not a connection string. Copy the URI form instead.");
  if (/\[YOUR-PASSWORD\]|\[YOUR_PASSWORD\]|<password>/i.test(s)) problems.push("The [YOUR-PASSWORD] placeholder is still in it — substitute the real password.");

  let u = null;
  try { u = new URL(s.trim()); } catch (_) {
    problems.push("It is not a valid URL. Expected: postgresql://USER:PASSWORD@HOST:5432/postgres");
    return problems;
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) problems.push(`Scheme is '${u.protocol}' — it should be postgresql://`);

  const host = u.hostname;
  if (!host) problems.push("No host found in the URL.");
  else if (!host.includes(".") && host !== "localhost" && host !== "127.0.0.1") {
    problems.push(`The host is '${host}', which is not a real hostname — the string is truncated or mangled. ` +
                  "This is what produces 'getaddrinfo ENOTFOUND " + host + "'.");
  }
  // An unencoded @ / : / ? in the password silently moves where the host starts.
  if ((s.match(/@/g) || []).length > 1) {
    problems.push("There is more than one '@'. If the password contains @ # / : or ?, URL-encode it " +
                  "(@ becomes %40, # becomes %23, / becomes %2F).");
  }
  // Supabase: the direct connection is IPv6-only and unreachable from Render.
  if (/^db\.[a-z0-9]+\.supabase\.co$/i.test(host)) {
    problems.push("This is Supabase's DIRECT connection, which is IPv6-only and cannot be reached from " +
                  "Render. Use the Session pooler string (host ends in .pooler.supabase.com, port 5432).");
  }
  return problems;
}

/** Throw with a readable explanation if the connection string can't work. */
function assertUsableConnectionString() {
  const problems = checkConnectionString();
  if (!problems.length) return;
  const u = (() => { try { return new URL(CONNECTION_STRING.trim()); } catch (_) { return null; } })();
  throw new Error(
    "DATABASE_URL cannot work:\n" +
    problems.map((p) => "     - " + p).join("\n") +
    (u ? `\n     (parsed host: '${u.hostname}', port: '${u.port || "none"}', database: '${u.pathname.slice(1) || "none"}')` : "") +
    "\n     Expected shape: postgresql://USER:PASSWORD@HOST:5432/postgres");
}

module.exports = { pool, query, one, tx, init, getSetting, setSetting,
                   checkConnectionString, assertUsableConnectionString };
