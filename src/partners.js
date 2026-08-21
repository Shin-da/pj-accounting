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

const DEFAULT_FLAGS = { commission: true, cost: false, margin: false, onelive: false };

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
  DEFAULT_FLAGS, listPartners, getPartner, createPartner, updatePartner,
  loadDataset, saveDataset, listDatasets, slugify,
};
