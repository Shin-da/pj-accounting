/*
 * One-off migration: JSON files (data/) -> PostgreSQL.
 *
 *     DATABASE_URL=... node src/migrate.js
 *
 * Reads whatever exists under data/ and loads it into the database:
 *   data/users.json          -> users
 *   data/partners.json       -> partners
 *   data/datasets/<slug>.json-> datasets + records
 *   data/latest.json         -> the RDR dataset (pre-partner legacy file)
 *   data/proofs/ + .json     -> proofs
 *   data/logos/  + .json     -> logos
 *   data/secret.key          -> settings.auth_secret (so logins survive)
 *
 * Idempotent: re-running skips anything already present, so it is safe to run
 * again if it fails partway. Nothing is deleted from data/ — the files stay as
 * a backup until you're happy.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");

const DATA = path.join(__dirname, "..", "data");
const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return fallback; }
};
let migrated = 0, skipped = 0;
const log = (msg) => console.log("   " + msg);

async function migrateSecret() {
  const f = path.join(DATA, "secret.key");
  if (!fs.existsSync(f)) return log("secret.key: none (a new one will be generated)");
  const existing = await db.getSetting("auth_secret");
  if (existing) return log("auth secret: already set, kept");
  await db.setSetting("auth_secret", fs.readFileSync(f, "utf8").trim());
  log("auth secret: migrated (existing logins stay valid)");
}

async function migratePartners() {
  const list = readJson(path.join(DATA, "partners.json"), []);
  if (!list.length) return log("partners: none in JSON");
  for (const p of list) {
    const exists = await db.one("SELECT slug FROM partners WHERE slug = $1", [p.slug]);
    if (exists) { skipped++; log(`partner ${p.slug}: already exists, skipped`); continue; }
    await db.query(
      "INSERT INTO partners (slug, name, flags, created_at) VALUES ($1,$2,$3,COALESCE($4,NOW()))",
      [p.slug, p.name || p.slug, JSON.stringify(p.flags || {}), p.createdAt || null]);
    migrated++; log(`partner ${p.slug}: migrated`);
  }
}

async function migrateUsers() {
  const list = readJson(path.join(DATA, "users.json"), []);
  if (!list.length) return log("users: none in JSON");
  for (const u of list) {
    const exists = await db.one("SELECT id FROM users WHERE lower(email) = lower($1)", [u.email]);
    if (exists) { skipped++; log(`user ${u.email}: already exists, skipped`); continue; }
    await db.query(
      `INSERT INTO users (id, email, name, role, partner_slug, password_hash, password_salt,
                          disabled, must_change, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,NOW()))`,
      [u.id || crypto.randomUUID(), u.email, u.name || u.email, u.role,
       u.partner || null, u.hash, u.salt, !!u.disabled, !!u.mustChange, u.createdAt || null]);
    migrated++; log(`user ${u.email} (${u.role}): migrated`);
  }
}

/** Insert a parsed dataset (records + meta) for one partner. */
async function insertDataset(slug, parsed, fileName) {
  const already = await db.one(
    "SELECT id FROM datasets WHERE partner_slug = $1 AND is_current = TRUE", [slug]);
  if (already) { skipped++; log(`dataset ${slug}: already has a current dataset, skipped`); return; }

  // Reuse the app's own insert path so the column mapping can't drift.
  const partners = require("./partners");
  const saved = await partners.saveDataset(slug, parsed, {
    fileName: fileName || (parsed.meta && parsed.meta.fileName) || null,
    uploadedBy: "migration",
  });
  migrated++; log(`dataset ${slug}: migrated ${saved.rows} records`);
}

async function migrateDatasets() {
  const dir = path.join(DATA, "datasets");
  let found = false;

  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const slug = f.replace(/\.json$/, "");
      const parsed = readJson(path.join(dir, f), null);
      if (!parsed || !Array.isArray(parsed.records)) continue;
      const partner = await db.one("SELECT slug FROM partners WHERE slug = $1", [slug]);
      if (!partner) { log(`dataset ${slug}: no such partner, skipped`); continue; }
      await insertDataset(slug, parsed, parsed.meta && parsed.meta.fileName);
      found = true;
    }
  }

  // Legacy single-dataset file from before partners existed.
  const legacy = path.join(DATA, "latest.json");
  if (!found && fs.existsSync(legacy)) {
    const parsed = readJson(legacy, null);
    if (parsed && Array.isArray(parsed.records)) {
      let rdr = await db.one("SELECT slug FROM partners WHERE slug = 'rdr'");
      if (!rdr) {
        await db.query("INSERT INTO partners (slug, name, flags) VALUES ('rdr','RDR',$1)",
                       [JSON.stringify({ commission: true, cost: false, margin: false, onelive: false })]);
        log("partner rdr: created for the legacy dataset");
      }
      await insertDataset("rdr", parsed, parsed.meta && parsed.meta.fileName);
      found = true;
    }
  }

  if (!found) log("datasets: none in JSON");
}

async function migrateImages(kind) {
  const idxFile = path.join(DATA, `${kind}.json`);
  const dir = path.join(DATA, kind);
  const idx = readJson(idxFile, {});
  const keys = Object.keys(idx);
  if (!keys.length) return log(`${kind}: none in JSON`);

  for (const key of keys) {
    const rec = idx[key];
    const abs = path.join(dir, rec.file);
    if (!fs.existsSync(abs)) { log(`${kind} ${key}: file missing, skipped`); continue; }
    const bytes = fs.readFileSync(abs);

    if (kind === "proofs") {
      // key is "<partner>|<reserve>"
      const sep = key.indexOf("|");
      const slug = key.slice(0, sep), reserve = key.slice(sep + 1);
      const exists = await db.one(
        "SELECT 1 AS ok FROM proofs WHERE partner_slug = $1 AND reserve = $2", [slug, reserve]);
      if (exists) { skipped++; continue; }
      await db.query(
        `INSERT INTO proofs (partner_slug, reserve, mime, bytes, uploaded_at)
         VALUES ($1,$2,$3,$4,COALESCE($5,NOW()))`,
        [slug, reserve, rec.mime, bytes, rec.uploadedAt || null]);
    } else {
      const exists = await db.one("SELECT 1 AS ok FROM logos WHERE partner_slug = $1", [key]);
      if (exists) { skipped++; continue; }
      await db.query(
        `INSERT INTO logos (partner_slug, mime, bytes, uploaded_at)
         VALUES ($1,$2,$3,COALESCE($4,NOW()))`,
        [key, rec.mime, bytes, rec.uploadedAt || null]);
    }
    migrated++; log(`${kind} ${key}: migrated (${bytes.length} bytes)`);
  }
}

async function main() {
  console.log("\n Migrating JSON files -> PostgreSQL\n");

  if (!fs.existsSync(DATA)) {
    console.log(" No data/ folder found — nothing to migrate. The app will start empty.\n");
    process.exit(0);
  }

  await db.init();
  console.log(" schema applied\n");

  // Order matters: partners before users (partner_slug) and before datasets.
  await migrateSecret();
  await migratePartners();
  await migrateUsers();
  await migrateDatasets();
  await migrateImages("proofs");
  await migrateImages("logos");

  // Report what landed, so the numbers can be eyeballed against the old app.
  const counts = await db.query(`
    SELECT (SELECT COUNT(*) FROM users)    AS users,
           (SELECT COUNT(*) FROM partners) AS partners,
           (SELECT COUNT(*) FROM datasets) AS datasets,
           (SELECT COUNT(*) FROM records)  AS records,
           (SELECT COUNT(*) FROM proofs)   AS proofs,
           (SELECT COUNT(*) FROM logos)    AS logos`);

  console.log(`\n Done — ${migrated} migrated, ${skipped} skipped (already present).`);
  console.log(" Now in the database:", JSON.stringify(counts[0]));
  console.log("\n The data/ folder was NOT deleted. Keep it until you've confirmed");
  console.log(" the app works, then archive it.\n");
  await db.pool.end();
}

main().catch((e) => {
  console.error("\n ! Migration failed:", e.message);
  console.error("   Nothing was deleted. Fix the problem and run it again.\n");
  process.exit(1);
});
