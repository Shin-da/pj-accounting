/*
 * Partner logos.
 *
 * Two sources, checked in order:
 *   1. Uploaded by an admin  -> data/logos/<slug>.<ext>   (instant, but on a
 *      free host the data/ folder resets on redeploy)
 *   2. Committed to the repo -> public/logos/<slug>.<ext> (persists forever,
 *      because it ships with the code)
 *
 * So you can upload now and, once a logo is final, drop the same file into
 * public/logos/ and commit it so it survives deploys.
 */
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("../config");

const UPLOAD_DIR = path.join(DATA_DIR, "logos");
const INDEX_JSON = path.join(DATA_DIR, "logos.json");
const STATIC_DIR = path.join(__dirname, "..", "public", "logos");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
              "image/gif": "gif", "image/svg+xml": "svg" };
const MIME_BY_EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
                      webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" };

function load() { try { return JSON.parse(fs.readFileSync(INDEX_JSON, "utf8")); } catch (_) { return {}; } }
function save(i) { fs.writeFileSync(INDEX_JSON, JSON.stringify(i, null, 2)); }
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");

function setLogo(slug, buffer, mime) {
  const ext = EXT[mime];
  if (!ext) throw new Error("unsupported image type (use PNG, JPG, WEBP, GIF or SVG)");
  const file = `${safe(slug)}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buffer);
  const idx = load();
  idx[slug] = { file, mime, uploadedAt: new Date().toISOString() };
  save(idx);
  return idx[slug];
}

// Uploaded logo first, then a committed one in public/logos/.
function getLogo(slug) {
  const rec = load()[slug];
  if (rec) {
    const abs = path.join(UPLOAD_DIR, rec.file);
    if (fs.existsSync(abs)) return { abs, mime: rec.mime, source: "upload" };
  }
  for (const ext of Object.keys(MIME_BY_EXT)) {
    const abs = path.join(STATIC_DIR, `${safe(slug)}.${ext}`);
    if (fs.existsSync(abs)) return { abs, mime: MIME_BY_EXT[ext], source: "repo" };
  }
  return null;
}

function hasLogo(slug) { return !!getLogo(slug); }

module.exports = { setLogo, getLogo, hasLogo };
