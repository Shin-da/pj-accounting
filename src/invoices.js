/*
 * Manually-created invoices.
 *
 * These live in the same `records` table as imported rows, distinguished by
 * source = 'manual' and dataset_id = NULL. That single fact is what keeps the
 * two worlds from fighting:
 *
 *   - an Excel upload replaces rows where source = 'import'
 *   - manual rows belong to the partner, so an upload never touches them
 *
 * An "invoice" is just the set of records sharing one invoice number for a
 * partner — the same shape the Excel produces, so every report, filter and
 * total downstream works without knowing the difference.
 */
const db = require("./db");

// ── commission ───────────────────────────────────────────
/**
 * Work out the commission for one line, using the same rules as the sheet:
 *   GOLD    -> rate is pesos per gram      -> rate x weight
 *   JEWELRY -> rate is a fraction (0.05)   -> rate x selling price
 * Returns null when it can't be computed, so the caller can fall back.
 */
function computeCommission({ commissionType, commissionRate, weight, amount }) {
  const rate = Number(commissionRate);
  if (!isFinite(rate) || rate === 0) return null;
  const type = String(commissionType || "").toUpperCase();
  if (type === "GOLD")    return round2(rate * (Number(weight) || 0));
  if (type === "JEWELRY") return round2(rate * (Number(amount) || 0));
  return null;
}
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── audit ────────────────────────────────────────────────
async function audit(client, { actor, action, partnerSlug, entity, details }) {
  const q = client ? client.query.bind(client) : db.query;
  await q(
    `INSERT INTO audit_log (actor, action, partner_slug, entity, details)
     VALUES ($1,$2,$3,$4,$5)`,
    [actor || null, action, partnerSlug || null, entity || null,
     JSON.stringify(details || {})]);
}

async function listAudit(partnerSlug, limit = 100) {
  return db.query(
    `SELECT at, actor, action, entity, details FROM audit_log
     WHERE ($1::text IS NULL OR partner_slug = $1)
     ORDER BY at DESC LIMIT $2`, [partnerSlug || null, limit]);
}

// ── helpers ──────────────────────────────────────────────
/** Does this invoice number already exist for the partner? Returns its source. */
async function findInvoice(partnerSlug, invoice) {
  const row = await db.one(
    `SELECT source, COUNT(*)::int AS lines FROM records
     WHERE partner_slug = $1 AND invoice = $2
     GROUP BY source LIMIT 1`,
    [partnerSlug, String(invoice).trim()]);
  return row || null;
}

/** Invoice numbers that exist as MANUAL records — used to warn on upload. */
async function manualInvoiceNumbers(partnerSlug) {
  const rows = await db.query(
    `SELECT DISTINCT invoice FROM records
     WHERE partner_slug = $1 AND source = 'manual' AND invoice IS NOT NULL`,
    [partnerSlug]);
  return new Set(rows.map((r) => r.invoice));
}

/** Normalise one submitted line item into a row, computing commission. */
function prepareItem(inv, it) {
  const weight = Number(it.weight) || 0;
  const amount = Number(it.amount) || 0;
  const rate   = it.commissionRate === "" || it.commissionRate == null
    ? null : Number(it.commissionRate);

  // Auto-calculate unless the admin supplied an explicit override.
  const auto = computeCommission({
    commissionType: it.commissionType, commissionRate: rate, weight, amount });
  const overridden = it.commissionValue !== "" && it.commissionValue != null;
  const commissionValue = overridden ? round2(it.commissionValue) : (auto ?? 0);

  return {
    txn_date: inv.date || null,
    invoice: String(inv.invoice).trim(),
    client: (inv.client || "").trim(),
    pj_code: (it.pjCode || "").trim(),
    item_code: (it.itemCode || "").trim(),
    item_type: (it.itemType || "").trim(),
    supplier: (it.supplier || "").trim(),
    weight,
    capital_per_gram: Number(it.capitalPerGram) || 0,
    supplier_price: Number(it.supplierPrice) || 0,
    amount,
    onelive: Number(it.onelive) || 0,
    commission: rate == null ? null : String(rate),
    commission_type: (it.commissionType || "").toUpperCase() || null,
    commission_value: commissionValue,
    commission_overridden: overridden,
  };
}

function validate(inv) {
  const errs = [];
  if (!inv || !String(inv.invoice || "").trim()) errs.push("invoice number is required");
  if (!String(inv.client || "").trim()) errs.push("client is required");
  if (!inv.date) errs.push("date is required");
  if (!Array.isArray(inv.items) || inv.items.length === 0) errs.push("at least one line item is required");
  (inv.items || []).forEach((it, i) => {
    if (!(Number(it.amount) > 0)) errs.push(`line ${i + 1}: item amount must be greater than 0`);
  });
  return errs;
}

// ── create / update / delete ─────────────────────────────
async function createInvoice(partnerSlug, inv, actor) {
  const errs = validate(inv);
  if (errs.length) throw new Error(errs.join("; "));

  const existing = await findInvoice(partnerSlug, inv.invoice);
  if (existing) {
    throw new Error(
      `invoice ${String(inv.invoice).trim()} already exists for this partner ` +
      `(${existing.source === "manual" ? "created here" : "from an Excel upload"})`);
  }

  const rows = inv.items.map((it) => prepareItem(inv, it));

  return db.tx(async (client) => {
    let n = 0;
    for (const r of rows) {
      n++;
      await client.query(
        `INSERT INTO records
           (dataset_id, partner_slug, source, row_no, txn_date, invoice, client,
            pj_code, item_code, item_type, supplier, weight, capital_per_gram,
            supplier_price, amount, onelive, commission, commission_type,
            commission_value, sheet, created_by, created_at)
         VALUES (NULL,$1,'manual',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'manual',$18,NOW())`,
        [partnerSlug, n, r.txn_date, r.invoice, r.client, r.pj_code, r.item_code,
         r.item_type, r.supplier, r.weight, r.capital_per_gram, r.supplier_price,
         r.amount, r.onelive, r.commission, r.commission_type, r.commission_value, actor]);
    }
    await audit(client, { actor, action: "invoice.create", partnerSlug,
      entity: rows[0].invoice,
      details: { lines: rows.length, client: rows[0].client, date: rows[0].txn_date,
                 amount: rows.reduce((s, r) => s + r.amount, 0) } });
    return { invoice: rows[0].invoice, lines: rows.length };
  });
}

/** Replace a manual invoice's lines wholesale. Imported invoices can't be edited. */
async function updateInvoice(partnerSlug, originalInvoiceNo, inv, actor) {
  const errs = validate(inv);
  if (errs.length) throw new Error(errs.join("; "));

  const existing = await findInvoice(partnerSlug, originalInvoiceNo);
  if (!existing) throw new Error("invoice not found");
  if (existing.source !== "manual") {
    throw new Error("this invoice came from an Excel upload and cannot be edited here — " +
                    "correct it in the spreadsheet and re-upload");
  }

  // Renaming onto an existing number would merge two invoices silently.
  const newNo = String(inv.invoice).trim();
  if (newNo !== String(originalInvoiceNo).trim()) {
    const clash = await findInvoice(partnerSlug, newNo);
    if (clash) throw new Error(`invoice ${newNo} already exists for this partner`);
  }

  const before = await db.query(
    `SELECT invoice, client, txn_date, amount, commission_value FROM records
     WHERE partner_slug = $1 AND invoice = $2 AND source = 'manual' ORDER BY row_no`,
    [partnerSlug, originalInvoiceNo]);

  const rows = inv.items.map((it) => prepareItem(inv, it));

  return db.tx(async (client) => {
    await client.query(
      "DELETE FROM records WHERE partner_slug = $1 AND invoice = $2 AND source = 'manual'",
      [partnerSlug, originalInvoiceNo]);
    let n = 0;
    for (const r of rows) {
      n++;
      await client.query(
        `INSERT INTO records
           (dataset_id, partner_slug, source, row_no, txn_date, invoice, client,
            pj_code, item_code, item_type, supplier, weight, capital_per_gram,
            supplier_price, amount, onelive, commission, commission_type,
            commission_value, sheet, created_by, created_at, updated_at)
         VALUES (NULL,$1,'manual',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'manual',$18,NOW(),NOW())`,
        [partnerSlug, n, r.txn_date, r.invoice, r.client, r.pj_code, r.item_code,
         r.item_type, r.supplier, r.weight, r.capital_per_gram, r.supplier_price,
         r.amount, r.onelive, r.commission, r.commission_type, r.commission_value, actor]);
    }
    await audit(client, { actor, action: "invoice.update", partnerSlug, entity: newNo,
      details: {
        renamedFrom: newNo !== String(originalInvoiceNo).trim() ? originalInvoiceNo : undefined,
        before: { lines: before.length,
                  amount: before.reduce((s, r) => s + Number(r.amount), 0) },
        after:  { lines: rows.length,
                  amount: rows.reduce((s, r) => s + r.amount, 0) },
      } });
    return { invoice: newNo, lines: rows.length };
  });
}

async function deleteInvoice(partnerSlug, invoiceNo, actor) {
  const existing = await findInvoice(partnerSlug, invoiceNo);
  if (!existing) throw new Error("invoice not found");
  if (existing.source !== "manual") {
    throw new Error("this invoice came from an Excel upload and cannot be deleted here");
  }
  const before = await db.query(
    "SELECT amount FROM records WHERE partner_slug = $1 AND invoice = $2 AND source = 'manual'",
    [partnerSlug, invoiceNo]);

  return db.tx(async (client) => {
    const r = await client.query(
      "DELETE FROM records WHERE partner_slug = $1 AND invoice = $2 AND source = 'manual'",
      [partnerSlug, invoiceNo]);
    await audit(client, { actor, action: "invoice.delete", partnerSlug, entity: invoiceNo,
      details: { lines: before.length,
                 amount: before.reduce((s, x) => s + Number(x.amount), 0) } });
    return { deleted: r.rowCount };
  });
}

/** Full detail of one manual invoice, for the edit form. */
async function getManualInvoice(partnerSlug, invoiceNo) {
  const rows = await db.query(
    `SELECT * FROM records
     WHERE partner_slug = $1 AND invoice = $2 AND source = 'manual'
     ORDER BY row_no`, [partnerSlug, invoiceNo]);
  if (!rows.length) return null;
  const f = rows[0];
  return {
    invoice: f.invoice,
    client: f.client,
    date: f.txn_date instanceof Date ? f.txn_date.toISOString().slice(0, 10) : String(f.txn_date || "").slice(0, 10),
    items: rows.map((r) => ({
      pjCode: r.pj_code || "", itemCode: r.item_code || "", itemType: r.item_type || "",
      supplier: r.supplier || "", weight: Number(r.weight) || 0,
      capitalPerGram: Number(r.capital_per_gram) || 0,
      supplierPrice: Number(r.supplier_price) || 0,
      amount: Number(r.amount) || 0, onelive: Number(r.onelive) || 0,
      commissionType: r.commission_type || "", commissionRate: r.commission || "",
      commissionValue: Number(r.commission_value) || 0,
    })),
  };
}

module.exports = {
  computeCommission, createInvoice, updateInvoice, deleteInvoice,
  getManualInvoice, findInvoice, manualInvoiceNumbers, audit, listAudit,
};
