/*
 * Partner expenses — costs the partner carries that come OFF their settlement.
 *
 * Like payments (src/payments.js) this is a running per-partner ledger, not a
 * per-invoice flag. It changes the payout waterfall by one term:
 *
 *     balance payable = commission earned − expenses − total paid
 *
 * Scope: only partners with flags.expenses = true (Léspérance today). The
 * server guards every route with that flag, and totalExpenses() joins on it
 * too — so even if a row existed for another partner it could never move a
 * balance.
 *
 * Who does what:
 *   - owner + admin  record and delete expenses
 *   - partner        sees the ledger read-only (and its effect on the balance)
 *
 * Every write is audit-logged: this reduces what we owe, so "who recorded this
 * and when" must always have an answer.
 */
const db = require("./db");

const ALLOWED_PROOF = { "image/jpeg": 1, "image/png": 1, "image/webp": 1,
                        "image/gif": 1, "application/pdf": 1 };

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Total expenses charged against the partner.
 *
 * The JOIN on partners.flags is the scoping guarantee: a partner without
 * flags.expenses = true sums to 0 no matter what's in the table, so this is
 * safe to call unconditionally from payments.summary().
 */
async function totalExpenses(partnerSlug) {
  const row = await db.one(
    `SELECT COALESCE(SUM(e.amount), 0) AS total
     FROM expenses e
     JOIN partners p ON p.slug = e.partner_slug
     WHERE e.partner_slug = $1
       AND COALESCE((p.flags->>'expenses')::boolean, FALSE) = TRUE`, [partnerSlug]);
  return round2(row ? row.total : 0);
}

/** Expense history, newest first. Proof bytes are NOT included (too heavy). */
async function listExpenses(partnerSlug) {
  return db.query(
    `SELECT id, amount, spent_on, category, description, reference, note,
            created_by, created_at,
            (proof_bytes IS NOT NULL) AS has_proof
     FROM expenses WHERE partner_slug = $1
     ORDER BY spent_on DESC, id DESC`, [partnerSlug]);
}

async function addExpense(partnerSlug, e, actor, proof) {
  const amount = Number(e.amount);
  if (!isFinite(amount) || amount <= 0) throw new Error("amount must be greater than 0");
  if (!e.spentOn) throw new Error("expense date is required");
  if (proof && proof.mime && !ALLOWED_PROOF[proof.mime]) {
    throw new Error("proof must be an image or PDF");
  }

  const row = await db.one(
    `INSERT INTO expenses (partner_slug, amount, spent_on, category, description,
                           reference, note, proof_mime, proof_bytes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, amount, spent_on`,
    [partnerSlug, round2(amount), e.spentOn, e.category || null, e.description || null,
     e.reference || null, e.note || null,
     proof ? proof.mime : null, proof ? proof.bytes : null, actor]);

  const after = await require("./payments").summary(partnerSlug);
  await db.query(
    `INSERT INTO audit_log (actor, action, partner_slug, entity, details)
     VALUES ($1,'expense.create',$2,$3,$4)`,
    [actor, partnerSlug, String(row.id),
     JSON.stringify({ amount: round2(amount), spentOn: e.spentOn,
                      category: e.category || null, reference: e.reference || null,
                      balanceAfter: after.balance })]);

  return { id: row.id, summary: after };
}

async function deleteExpense(id, actor) {
  const row = await db.one(
    "SELECT partner_slug, amount, spent_on, category, reference FROM expenses WHERE id = $1", [id]);
  if (!row) throw new Error("expense not found");

  await db.query("DELETE FROM expenses WHERE id = $1", [id]);
  const after = await require("./payments").summary(row.partner_slug);
  await db.query(
    `INSERT INTO audit_log (actor, action, partner_slug, entity, details)
     VALUES ($1,'expense.delete',$2,$3,$4)`,
    [actor, row.partner_slug, String(id),
     JSON.stringify({ amount: Number(row.amount), spentOn: row.spent_on,
                      category: row.category, reference: row.reference,
                      balanceAfter: after.balance })]);
  return { deleted: true, summary: after };
}

/** Proof attachment for one expense (partner scoping is enforced by the route). */
async function getProof(id) {
  const row = await db.one(
    "SELECT partner_slug, proof_mime, proof_bytes FROM expenses WHERE id = $1", [id]);
  if (!row || !row.proof_bytes) return null;
  return { partnerSlug: row.partner_slug, mime: row.proof_mime, bytes: row.proof_bytes };
}

module.exports = { totalExpenses, listExpenses, addExpense, deleteExpense, getProof };
