/*
 * Proof-of-invoice images — stored in PostgreSQL.
 *
 * Admins upload one image per invoice (partner + reserve number).
 * Keeping them in the database means there is ONE thing to back up, and
 * nothing is lost when the app redeploys.
 *
 * If these ever grow large (thousands of photos), move the bytes to object
 * storage (S3 / Backblaze B2) and keep just the URL in this table.
 */
const db = require("./db");

const ALLOWED = { "image/jpeg": 1, "image/png": 1, "image/webp": 1, "image/gif": 1 };

async function setProof(partnerSlug, reserve, buffer, mime) {
  if (!ALLOWED[mime]) throw new Error("unsupported image type (use JPG, PNG, WEBP or GIF)");
  const row = await db.one(
    `INSERT INTO proofs (partner_slug, reserve, mime, bytes, uploaded_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (partner_slug, reserve)
     DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, uploaded_at = NOW()
     RETURNING uploaded_at`,
    [partnerSlug, String(reserve).trim(), mime, buffer]);
  return { uploadedAt: row.uploaded_at };
}

async function getProof(partnerSlug, reserve) {
  const row = await db.one(
    "SELECT mime, bytes, uploaded_at FROM proofs WHERE partner_slug = $1 AND reserve = $2",
    [partnerSlug, String(reserve).trim()]);
  if (!row) return null;
  return { mime: row.mime, bytes: row.bytes, uploadedAt: row.uploaded_at };
}

async function hasProof(partnerSlug, reserve) {
  const row = await db.one(
    "SELECT 1 AS ok FROM proofs WHERE partner_slug = $1 AND reserve = $2",
    [partnerSlug, String(reserve).trim()]);
  return !!row;
}

/** Set of reserve numbers that have a proof — used for the list badges. */
async function proofSet(partnerSlug) {
  const rows = await db.query("SELECT reserve FROM proofs WHERE partner_slug = $1", [partnerSlug]);
  return new Set(rows.map((r) => r.reserve));
}

module.exports = { setProof, getProof, hasProof, proofSet };
