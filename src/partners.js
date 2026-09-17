/*
 * Partners and their uploaded datasets — PostgreSQL backed.
 *
 * A partner (RDR, and future ones) has:
 *   - a row in `partners` (slug, name, visibility flags)
 *   - one or more rows in `datasets`, one per Excel upload, with the newest
 *     marked is_current
 *   - the line items in `records`, linked to a dataset
 *
 * Keeping old datasets means a bad upload can be rolled back instead of
 * overwriting history — something the JSON-file version could not do.
 *
 * Visibility flags decide what a PARTNER user may see of their own data.
 * Admins and the owner always see everything. Default is privacy-safe.
 */
const db = require("./db");
const invoices = require("./invoices");

const DEFAULT_FLAGS = { commission: true, cost: false, margin: false, onelive: false, expenses: false };

/*
 * Partners that must exist on every deploy, regardless of what's in the
 * database. Seeded (insert-if-missing) on startup by seedPartners(), so a
 * fresh environment — or a new partner added here — comes up ready without a
 * manual step in the admin UI.
 *
 * `expenses: true` turns on the per-partner expenses ledger (see
 * docs/EXPENSES-DESIGN.md). Only Léspérance has it; every other partner keeps
 * the default false and the feature stays invisible to them.
 */
const BUILTIN_PARTNERS = [
  { slug: "lesperance", name: "Léspérance", flags: { expenses: true } },
];

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "partner";
}

// ── partners ─────────────────────────────────────────────
async function listPartners() {
  return db.query("SELECT slug, name, flags, created_at FROM partners ORDER BY created_at, slug");
}

async function getPartner(slug) {
  return db.one("SELECT slug, name, flags, created_at FROM partners WHERE slug = $1", [slug]);
}

async function createPartner({ name, flags }) {
  const base = slugify(name);
  let slug = base, n = 1;
  while (await getPartner(slug)) slug = base + "-" + (++n);

  return db.one(
    `INSERT INTO partners (slug, name, flags) VALUES ($1, $2, $3)
     RETURNING slug, name, flags, created_at`,
    [slug, String(name || slug).trim(), JSON.stringify({ ...DEFAULT_FLAGS, ...(flags || {}) })]);
}

/**
 * Create a partner with an explicit slug if it doesn't exist yet. Unlike
 * createPartner(), the slug is given (not derived from the name), so a boot
 * seed is stable and re-running is a no-op. An existing partner is left
 * untouched — name and flags edited in the admin UI are never clobbered by a
 * redeploy.
 */
async function ensurePartner({ slug, name, flags }) {
  const row = await db.one(
    `INSERT INTO partners (slug, name, flags) VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO NOTHING
     RETURNING slug, name, flags, created_at`,
    [slug, String(name || slug).trim(), JSON.stringify({ ...DEFAULT_FLAGS, ...(flags || {}) })]);
  return row ? { partner: row, created: true } : { partner: await getPartner(slug), created: false };
}

/** Insert-if-missing every BUILTIN_PARTNERS entry. Called once at startup. */
async function seedPartners() {
  const created = [];
  for (const p of BUILTIN_PARTNERS) {
    const { created: made } = await ensurePartner(p);
    if (made) created.push(p.slug);
  }
  if (created.length) console.log(` * seeded partner(s): ${created.join(", ")}`);
  return created;
}

async function updatePartner(slug, patch) {
  const p = await getPartner(slug);
  if (!p) throw new Error("partner not found");
  const name  = patch.name != null ? String(patch.name).trim() : p.name;
  const flags = patch.flags ? { ...p.flags, ...patch.flags } : p.flags;
  return db.one(
    `UPDATE partners SET name = $1, flags = $2 WHERE slug = $3
     RETURNING slug, name, flags, created_at`,
    [name, JSON.stringify(flags), slug]);
}

// ── datasets + records ───────────────────────────────────
// Column order used for the bulk insert of line items.
const REC_COLS = [
  "dataset_id", "partner_slug", "row_no", "txn_date", "invoice", "client",
  "pj_code", "item_code", "item_type", "supplier", "weight", "capital_per_gram",
  "supplier_price", "amount", "onelive", "commission", "commission_type",
  "commission_value", "sheet", "seller_status",
];

/** Convert a parsed record (camelCase, from parse.js) into a row array. */
function recordToRow(datasetId, slug, r, i) {
  return [
    datasetId, slug, i + 1,
    r.date || null, r.invoice || null, r.client || null,
    r.pjCode || null, r.itemCode || null, r.itemType || null, r.supplier || null,
    Number(r.weight) || 0, Number(r.capitalPerGram) || 0, Number(r.supplierPrice) || 0,
    Number(r.amount) || 0, Number(r.onelive) || 0,
    r.commission == null ? null : String(r.commission),
    r.commissionType || null, Number(r.commissionValue) || 0, r.sheet || null,
    r.sellerStatus || null,
  ];
}

/** Convert a database row back into the camelCase shape the app expects. */
function rowToRecord(row) {
  return {
    // A DATE column comes back from pg as a Date at LOCAL midnight, so
    // toISOString() would shift it to the previous day anywhere east of UTC.
    // Read the local calendar parts instead.
    date: row.txn_date
      ? (row.txn_date instanceof Date
          ? `${row.txn_date.getFullYear()}-${String(row.txn_date.getMonth() + 1).padStart(2, "0")}-${String(row.txn_date.getDate()).padStart(2, "0")}`
          : String(row.txn_date).slice(0, 10))
      : null,
    invoice: row.invoice || "",
    client: row.client || "",
    pjCode: row.pj_code || "",
    itemCode: row.item_code || "",
    itemType: row.item_type || "",
    supplier: row.supplier || "—",
    weight: Number(row.weight) || 0,
    capitalPerGram: Number(row.capital_per_gram) || 0,
    supplierPrice: Number(row.supplier_price) || 0,
    amount: Number(row.amount) || 0,
    onelive: Number(row.onelive) || 0,
    commission: row.commission == null ? "" : String(row.commission),
    commissionType: row.commission_type || "",
    commissionValue: Number(row.commission_value) || 0,
    sheet: row.sheet || "",
    sellerStatus: row.seller_status || "",
    source: row.source || "import",
  };
}

/**
 * Save a freshly parsed upload as the partner's current dataset.
 * Runs in a transaction: either the whole upload lands, or none of it does.
 */
async function saveDataset(slug, parsed, opts = {}) {
  return db.tx(async (client) => {
    await client.query("UPDATE datasets SET is_current = FALSE WHERE partner_slug = $1", [slug]);

    // The original .xlsx is kept so any past upload can be downloaded or
    // re-parsed later. Manual invoices are NOT touched here - they have
    // source = 'manual' and belong to the partner, not to this upload.
    const ds = await client.query(
      `INSERT INTO datasets (partner_slug, file_name, uploaded_by, meta, is_current,
                             file_bytes, file_mime)
       VALUES ($1, $2, $3, $4, TRUE, $5, $6) RETURNING id`,
      [slug, opts.fileName || (parsed.meta && parsed.meta.fileName) || null,
       opts.uploadedBy || null, JSON.stringify(parsed.meta || {}),
       opts.fileBytes || null, opts.fileMime || null]);
    const datasetId = ds.rows[0].id;

    // Bulk insert in chunks — one statement per ~500 rows keeps the query
    // size sane while staying far faster than a round trip per row.
    const rows = parsed.records || [];
    const CHUNK = 500;
    for (let start = 0; start < rows.length; start += CHUNK) {
      const slice = rows.slice(start, start + CHUNK);
      const values = [];
      const tuples = slice.map((r, j) => {
        const vals = recordToRow(datasetId, slug, r, start + j);
        const ph = vals.map((_, k) => `$${values.length + k + 1}`);
        values.push(...vals);
        return `(${ph.join(",")})`;
      });
      await client.query(
        `INSERT INTO records (${REC_COLS.join(",")}) VALUES ${tuples.join(",")}`, values);
    }

    return { datasetId, rows: rows.length };
  });
}

// ── merge upload (append/update, never silently replace) ────
/*
 * Match an incoming spreadsheet row to an existing DB row by
 * (invoice, PJ code, item code) — the closest thing this data has to a
 * stable line-item identity. When several rows share the same key (blank or
 * placeholder codes, e.g. "-" / "N/A" on older invoices), pairs are matched
 * by order of appearance within that key. Not perfect, but it means a
 * genuinely new line is still recognised as new rather than as a false
 * "changed" match, and every guess here is reviewable before it's applied —
 * nothing is written to a matched row until the admin says overwrite.
 */
function rowKey(invoice, pjCode, itemCode) {
  const n = (v) => String(v ?? "").trim().toUpperCase();
  return `${n(invoice)}|${n(pjCode)}|${n(itemCode)}`;
}

const CMP_NUM = ["weight", "capitalPerGram", "supplierPrice", "amount", "onelive", "commissionValue"];
const DB_COL = { capitalPerGram: "capital_per_gram", supplierPrice: "supplier_price",
                 commissionValue: "commission_value", commissionType: "commission_type",
                 sellerStatus: "seller_status", itemType: "item_type" };

/** Normalise one row — DB shape (snake_case) or parsed shape (camelCase) — for comparison. */
function comparable(row, isDbRow) {
  const g = (camel) => (isDbRow ? row[DB_COL[camel] || camel] : row[camel]);
  const date = isDbRow
    ? (row.txn_date instanceof Date
        ? `${row.txn_date.getFullYear()}-${String(row.txn_date.getMonth() + 1).padStart(2, "0")}-${String(row.txn_date.getDate()).padStart(2, "0")}`
        : (row.txn_date ? String(row.txn_date).slice(0, 10) : null))
    : (row.date || null);
  const out = {
    date,
    client: String(g("client") ?? "").trim(),
    itemType: String(g("itemType") ?? "").trim(),
    // "—" is parse.js's own placeholder for "no supplier on the sheet", and a
    // blank/NULL database value (e.g. from an older import) means the same
    // thing — normalise both to it so a legacy blank row isn't flagged as
    // "changed" just because a fresh upload spells its blank differently.
    supplier: String(g("supplier") ?? "").trim() || "—",
    commission: String(g("commission") ?? "").trim(),
    commissionType: String(g("commissionType") ?? "").trim().toUpperCase(),
    sellerStatus: String(g("sellerStatus") ?? "").trim().toUpperCase(),
  };
  for (const f of CMP_NUM) out[f] = Math.round((Number(g(f)) || 0) * 100);
  return out;
}

/** Field names (in the incoming/parsed shape) that differ, or [] when the row is unchanged. */
function diffFields(existingDbRow, incomingRecord) {
  const a = comparable(existingDbRow, true);
  const b = comparable(incomingRecord, false);
  return Object.keys(a).filter((k) => a[k] !== b[k]);
}

/**
 * Merge a freshly parsed upload into the partner's live (is_current) dataset
 * instead of replacing it:
 *   - a row whose key isn't already there            -> inserted
 *   - a row whose key matches and every field is same -> left alone (it's
 *     already in the database — nothing to do)
 *   - a row whose key matches but a field differs      -> reported back as a
 *     conflict; NOTHING is changed until the admin picks overwrite or keep
 *     via applyConflictDecisions()
 * Rows already in the database that the new file doesn't mention at all are
 * never touched — this only adds and (on explicit request) updates, never
 * deletes. Runs in one transaction: either the whole merge lands, or none of
 * it does.
 */
async function mergeUpload(slug, parsed, opts = {}) {
  return db.tx(async (client) => {
    const cur = (await client.query(
      `SELECT id FROM datasets WHERE partner_slug = $1 AND is_current = TRUE
       ORDER BY uploaded_at DESC LIMIT 1`, [slug])).rows[0];

    let datasetId;
    if (cur) {
      datasetId = cur.id;
      // Keep the live dataset row's metadata pointed at the most recent file
      // that contributed to it — the full history of every contributing
      // upload lives in audit_log, not here.
      await client.query(
        `UPDATE datasets SET file_name = $1, uploaded_by = $2, uploaded_at = NOW(),
                              meta = $3, file_bytes = $4, file_mime = $5 WHERE id = $6`,
        [opts.fileName || null, opts.uploadedBy || null, JSON.stringify(parsed.meta || {}),
         opts.fileBytes || null, opts.fileMime || null, datasetId]);
    } else {
      const ds = await client.query(
        `INSERT INTO datasets (partner_slug, file_name, uploaded_by, meta, is_current,
                               file_bytes, file_mime)
         VALUES ($1, $2, $3, $4, TRUE, $5, $6) RETURNING id`,
        [slug, opts.fileName || null, opts.uploadedBy || null, JSON.stringify(parsed.meta || {}),
         opts.fileBytes || null, opts.fileMime || null]);
      datasetId = ds.rows[0].id;
    }

    const existingRows = (await client.query(
      `SELECT * FROM records WHERE dataset_id = $1 AND source = 'import' ORDER BY id`,
      [datasetId])).rows;

    const byKey = new Map();
    for (const r of existingRows) {
      const k = rowKey(r.invoice, r.pj_code, r.item_code);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }
    let ambiguousGroups = 0;
    for (const bucket of byKey.values()) if (bucket.length > 1) ambiguousGroups++;

    const used = new Map();
    const toInsert = [];
    const conflicts = [];
    let unchanged = 0;

    for (const rec of parsed.records || []) {
      const k = rowKey(rec.invoice, rec.pjCode, rec.itemCode);
      const bucket = byKey.get(k) || [];
      const seen = used.get(k) || 0;
      if (seen < bucket.length) {
        used.set(k, seen + 1);
        const existingRow = bucket[seen];
        const changed = diffFields(existingRow, rec);
        if (!changed.length) {
          unchanged++;
        } else {
          conflicts.push({
            recordId: existingRow.id,
            invoice: rec.invoice, pjCode: rec.pjCode, itemCode: rec.itemCode,
            client: rec.client, changedFields: changed,
            existing: rowToRecord(existingRow), incoming: rec,
          });
        }
      } else {
        toInsert.push(rec);
      }
    }

    const CHUNK = 500;
    for (let start = 0; start < toInsert.length; start += CHUNK) {
      const slice = toInsert.slice(start, start + CHUNK);
      const values = [];
      const tuples = slice.map((r, j) => {
        const vals = recordToRow(datasetId, slug, r, start + j);
        const ph = vals.map((_, k2) => `$${values.length + k2 + 1}`);
        values.push(...vals);
        return `(${ph.join(",")})`;
      });
      await client.query(
        `INSERT INTO records (${REC_COLS.join(",")}) VALUES ${tuples.join(",")}`, values);
    }

    return { datasetId, added: toInsert.length, unchanged, conflicts, ambiguousGroups };
  });
}

/**
 * Apply admin decisions on rows a merge flagged as changed. Only rows the
 * admin explicitly chose to overwrite are touched; anything left out keeps
 * exactly the value already in the database.
 */
async function applyConflictDecisions(slug, decisions, actor) {
  return db.tx(async (client) => {
    let applied = 0;
    for (const d of decisions || []) {
      const rows = (await client.query(
        `SELECT * FROM records WHERE id = $1 AND partner_slug = $2 AND source = 'import'`,
        [d.recordId, slug])).rows;
      if (!rows.length) continue;
      const before = rows[0];
      const rec = d.incoming || {};
      await client.query(
        `UPDATE records SET
           txn_date = $1, client = $2, item_type = $3, supplier = $4, weight = $5,
           capital_per_gram = $6, supplier_price = $7, amount = $8, onelive = $9,
           commission = $10, commission_type = $11, commission_value = $12,
           seller_status = $13, updated_at = NOW()
         WHERE id = $14`,
        [rec.date || null, String(rec.client || "").trim(), String(rec.itemType || "").trim(),
         String(rec.supplier || "").trim(), Number(rec.weight) || 0, Number(rec.capitalPerGram) || 0,
         Number(rec.supplierPrice) || 0, Number(rec.amount) || 0, Number(rec.onelive) || 0,
         rec.commission == null ? null : String(rec.commission),
         rec.commissionType ? String(rec.commissionType).toUpperCase() : null,
         Number(rec.commissionValue) || 0,
         rec.sellerStatus ? String(rec.sellerStatus).toUpperCase() : null,
         before.id]);
      applied++;
      await invoices.audit(client, {
        actor, action: "upload.overwrite-row", partnerSlug: slug, entity: before.invoice,
        details: { recordId: before.id, before: rowToRecord(before), after: rec },
      });
    }
    return { applied };
  });
}

/** The partner's current dataset, in the same shape the app used to read from JSON. */
async function loadDataset(slug) {
  const ds = await db.one(
    `SELECT id, file_name, uploaded_at, meta FROM datasets
     WHERE partner_slug = $1 AND is_current = TRUE
     ORDER BY uploaded_at DESC LIMIT 1`, [slug]);
  if (!ds) {
    // No upload yet - but there may still be manual invoices to show.
    const manual = await db.query(
      "SELECT * FROM records WHERE partner_slug = $1 AND source = 'manual' ORDER BY txn_date NULLS LAST, invoice, row_no",
      [slug]);
    if (!manual.length) return { records: [], meta: null };
    return {
      records: manual.map(rowToRecord),
      meta: { rows: manual.length, manualOnly: true, uploadedAt: new Date().toISOString() },
    };
  }

  // Imported rows from the current dataset PLUS every manual invoice for this
  // partner. Manual rows survive uploads by design.
  const rows = await db.query(
    `SELECT * FROM records
     WHERE (dataset_id = $1 AND source = 'import') OR (partner_slug = $2 AND source = 'manual')
     ORDER BY txn_date NULLS LAST, invoice, row_no`, [ds.id, slug]);

  const meta = { ...(ds.meta || {}) };
  meta.uploadedAt = ds.uploaded_at instanceof Date ? ds.uploaded_at.toISOString() : ds.uploaded_at;
  if (ds.file_name) meta.fileName = ds.file_name;
  meta.rows = rows.length;

  return { records: rows.map(rowToRecord), meta };
}

/**
 * Reactivate a past upload as the partner's current dataset — the undo for a
 * bad upload (e.g. a partial sheet that hid older rows). The dataset's own
 * `records` were never touched by the bad upload, so this is a pure flag
 * flip: no row is re-inserted or re-parsed.
 */
async function restoreDataset(slug, datasetId) {
  return db.tx(async (client) => {
    const found = await client.query(
      "SELECT id FROM datasets WHERE id = $1 AND partner_slug = $2", [datasetId, slug]);
    if (!found.rows.length) throw new Error("dataset not found for this partner");
    await client.query("UPDATE datasets SET is_current = FALSE WHERE partner_slug = $1", [slug]);
    await client.query("UPDATE datasets SET is_current = TRUE WHERE id = $1", [datasetId]);
  });
}

/** Upload history for a partner (newest first). */
async function listDatasets(slug) {
  return db.query(
    `SELECT d.id, d.file_name, d.uploaded_at, d.uploaded_by, d.is_current,
            COUNT(r.id)::int AS rows
     FROM datasets d
     LEFT JOIN records r ON r.dataset_id = d.id
     WHERE d.partner_slug = $1
     GROUP BY d.id, d.file_name, d.uploaded_at, d.uploaded_by, d.is_current
     ORDER BY d.uploaded_at DESC`, [slug]);
}

module.exports = {
  DEFAULT_FLAGS, BUILTIN_PARTNERS, listPartners, getPartner, createPartner,
  ensurePartner, seedPartners, updatePartner,
  loadDataset, saveDataset, mergeUpload, applyConflictDecisions,
  restoreDataset, listDatasets, slugify,
};
