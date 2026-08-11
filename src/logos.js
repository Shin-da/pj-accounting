/*
 * Partner logos — stored in PostgreSQL.
 *
 * Uploaded by an admin, shown in the header for whichever partner is being
 * viewed. Falls back to a committed file in public/logos/<slug>.<ext> if no
 * upload exists, so a logo can also ship with the code.
 */
const fs = require("fs");
const path = require("path");
const db = require("./db");

const STATIC_DIR = path.join(__dirname, "..", "public", "logos");
const ALLOWED = {
  "image/jpeg": 1, "image/png": 1, "image/webp": 1, "image/gif": 1, "image/svg+xml": 1,
};
const MIME_BY_EXT = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
};
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");

async function setLogo(partnerSlug, buffer, mime) {
  if (!ALLOWED[mime]) throw new Error("unsupported image type (use PNG, JPG, WEBP, GIF or SVG)");
  const row = await db.one(
    `INSERT INTO logos (partner_slug, mime, bytes, uploaded_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (partner_slug)
     DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, uploaded_at = NOW()
     RETURNING uploaded_at`,
    [partnerSlug, mime, buffer]);
  return { uploadedAt: row.uploaded_at };
}

/** Uploaded logo first, then a committed one in public/logos/. */
async function getLogo(partnerSlug) {
  const row = await db.one(
    "SELECT mime, bytes, uploaded_at FROM logos WHERE partner_slug = $1", [partnerSlug]);
  if (row) return { mime: row.mime, bytes: row.bytes, source: "db", uploadedAt: row.uploaded_at };

  for (const ext of Object.keys(MIME_BY_EXT)) {
    const abs = path.join(STATIC_DIR, `${safe(partnerSlug)}.${ext}`);
    if (fs.existsSync(abs)) {
      return { mime: MIME_BY_EXT[ext], bytes: fs.readFileSync(abs), source: "repo" };
    }
  }
  return null;
}

async function hasLogo(partnerSlug) {
  return !!(await getLogo(partnerSlug));
}

module.exports = { setLogo, getLogo, hasLogo };
