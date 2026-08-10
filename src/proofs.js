/*
 * Proof-of-invoice images.
 *
 * Admins upload one image per invoice (keyed by partner + reserve no.).
 * Files live in data/proofs/, indexed in data/proofs.json. On the free host
 * these reset on redeploy (like the rest of the data) — they persist once a
 * disk is attached.
 */
const fs = require("fs");
const path = require("path");
const { PROOFS_DIR, PROOFS_JSON } = require("../config");

fs.mkdirSync(PROOFS_DIR, { recursive: true });

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

function load() { try { return JSON.parse(fs.readFileSync(PROOFS_JSON, "utf8")); } catch (_) { return {}; } }
function save(idx) { fs.writeFileSync(PROOFS_JSON, JSON.stringify(idx, null, 2)); }

const key = (partner, reserve) => `${partner}|${String(reserve).trim()}`;
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");

function setProof(partner, reserve, buffer, mime) {
  const ext = EXT[mime];
  if (!ext) throw new Error("unsupported image type (use JPG, PNG, WEBP, or GIF)");
  const file = `${safe(partner)}__${safe(reserve)}.${ext}`;
  fs.writeFileSync(path.join(PROOFS_DIR, file), buffer);
  const idx = load();
  idx[key(partner, reserve)] = { file, mime, uploadedAt: new Date().toISOString() };
  save(idx);
  return idx[key(partner, reserve)];
}

function getProof(partner, reserve) {
  const rec = load()[key(partner, reserve)];
  if (!rec) return null;
  const abs = path.join(PROOFS_DIR, rec.file);
  if (!fs.existsSync(abs)) return null;
  return { ...rec, abs };
}

function hasProof(partner, reserve) { return !!load()[key(partner, reserve)]; }

// Set of reserve numbers (for a partner) that have a proof — for list badges.
function proofSet(partner) {
  const out = new Set();
  const pre = partner + "|";
  for (const k of Object.keys(load())) if (k.startsWith(pre)) out.add(k.slice(pre.length));
  return out;
}

module.exports = { setProof, getProof, hasProof, proofSet };
