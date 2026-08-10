/*
 * Partners + their datasets.
 *
 * Each partner (RDR, and future ones) has:
 *   - a record in partners.json (slug, name, visibility flags)
 *   - a parsed dataset in datasets/<slug>.json (from the admin's Excel upload)
 *
 * Visibility flags decide what a PARTNER user may see of their own data.
 * Admins and the owner always see everything. Default is privacy-safe:
 * sales + their commission, but not PJ's cost / margin / ONELIVE profit.
 */
const fs = require("fs");
const path = require("path");
const { PARTNERS_JSON, DATASETS_DIR, LATEST_JSON } = require("../config");

fs.mkdirSync(DATASETS_DIR, { recursive: true });

const DEFAULT_FLAGS = { commission: true, cost: false, margin: false, onelive: false };

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "partner";
}

function load() {
  try { return JSON.parse(fs.readFileSync(PARTNERS_JSON, "utf8")); } catch (_) { return []; }
}
function save(list) { fs.writeFileSync(PARTNERS_JSON, JSON.stringify(list, null, 2)); }

function datasetPath(slug) { return path.join(DATASETS_DIR, slug + ".json"); }
function loadDataset(slug) {
  try { return JSON.parse(fs.readFileSync(datasetPath(slug), "utf8")); }
  catch (_) { return { records: [], meta: null }; }
}
function saveDataset(slug, parsed) { fs.writeFileSync(datasetPath(slug), JSON.stringify(parsed)); }

function listPartners() { return load(); }
function getPartner(slug) { return load().find((p) => p.slug === slug) || null; }

function createPartner({ name, flags }) {
  const list = load();
  let slug = slugify(name), n = 1;
  while (list.some((p) => p.slug === slug)) slug = slugify(name) + "-" + (++n);
  const p = { slug, name: String(name || slug).trim(),
    flags: { ...DEFAULT_FLAGS, ...(flags || {}) }, createdAt: new Date().toISOString() };
  list.push(p); save(list);
  return p;
}
function updatePartner(slug, patch) {
  const list = load();
  const p = list.find((x) => x.slug === slug);
  if (!p) throw new Error("partner not found");
  if (patch.name != null) p.name = String(patch.name).trim();
  if (patch.flags) p.flags = { ...p.flags, ...patch.flags };
  save(list);
  return p;
}

// One-time migration: if there are no partners yet, create RDR and move any
// existing single dataset (latest.json) under it, so nothing is lost.
function migrateIfNeeded() {
  if (load().length) return;
  const rdr = createPartner({ name: "RDR", flags: DEFAULT_FLAGS });
  try {
    if (fs.existsSync(LATEST_JSON) && !fs.existsSync(datasetPath(rdr.slug))) {
      fs.copyFileSync(LATEST_JSON, datasetPath(rdr.slug));
      console.log(" * migrated existing dataset -> partner 'rdr'");
    }
  } catch (_) {}
}

module.exports = {
  DEFAULT_FLAGS, listPartners, getPartner, createPartner, updatePartner,
  loadDataset, saveDataset, migrateIfNeeded, slugify,
};
