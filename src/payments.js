/*
 * Commission payouts — money from Perfect Jewel to the partner.
 *
 * This is a running ACCOUNT, not a per-invoice flag, because that's how the
 * money actually moves: one transfer settles many invoices at once.
 *
 *     balance payable = total commission earned − expenses − total paid
 *
 * (expenses is 0 for every partner except those with flags.expenses set —
 * see src/expenses.js. Today that's only Léspérance.)
 *
 * Who does what:
 *   - owner + admin  record and delete payments
 *   - partner        sees the statement read-only (earned, paid, balance)
 *
 * Every write is audit-logged: this is money, so "who recorded this and when"
 * must always have an answer.
 */
const db = require("./db");
const expenses = require("./expenses");

const ALLOWED_PROOF = { "image/jpeg": 1, "image/png": 1, "image/webp": 1,
                        "image/gif": 1, "application/pdf": 1 };

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Total commission the partner has earned.
 *
 * IMPORTANT: only the CURRENT dataset plus manual invoices — the same set the
 * sales register shows. Superseded uploads are still in `records` (that's the
 * version history), so summing the whole table double-counts every re-upload.
 */
async function totalEarned(partnerSlug) {
  const row = await db.one(
    `SELECT COALESCE(SUM(r.commission_value), 0) AS earned
     FROM records r
     LEFT JOIN datasets d ON d.id = r.dataset_id
     WHERE r.partner_slug = $1
       AND (r.source = 'manual' OR d.is_current = TRUE)`, [partnerSlug]);
  return round2(row ? row.earned : 0);
}

/** Total we have actually paid them. */
async function totalPaid(partnerSlug) {
  const row = await db.one(
    "SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE partner_slug = $1",
    [partnerSlug]);
  return round2(row ? row.paid : 0);
}

/**
 * The statement figures. `balance` is what we still owe — the number the
 * partner actually cares about, and the one Tatay will be asked about.
 *
 *     balance = earned − expenses − paid
 *
 * `expenses` is 0 unless the partner has flags.expenses set (only Léspérance
 * today); expenses.totalExpenses() enforces that in SQL, so this is safe to
 * call for everyone. A balance can now go negative — expenses + paid exceeding
 * commission means the partner owes Perfect Jewel — hence the `credit` status.
 */
async function summary(partnerSlug) {
  // Three independent aggregates — run them in one round-trip batch rather
  // than three sequential hops to the database.
  const [earned, paid, expensesTotal] = await Promise.all([
    totalEarned(partnerSlug),
    totalPaid(partnerSlug),
    expenses.totalExpenses(partnerSlug),
  ]);
  const balance = round2(earned - expensesTotal - paid);
  const settledUp = earned > 0 || expensesTotal > 0 || paid > 0;
  return {
    earned, expenses: expensesTotal, paid, balance,
    status: balance < -0.005 ? "credit"
          : balance <= 0.005 ? (settledUp ? "settled" : "nothing due")
          : paid > 0 ? "partially paid" : "unpaid",
  };
}

/** Payment history, newest first. Proof bytes are NOT included (too heavy). */
async function listPayments(partnerSlug) {
  return db.query(
    `SELECT id, amount, paid_on, method, reference, note, created_by, created_at,
            (proof_bytes IS NOT NULL) AS has_proof
     FROM payments WHERE partner_slug = $1
     ORDER BY paid_on DESC, id DESC`, [partnerSlug]);
}

async function addPayment(partnerSlug, p, actor, proof) {
  const amount = Number(p.amount);
  if (!isFinite(amount) || amount <= 0) throw new Error("amount must be greater than 0");
  if (!p.paidOn) throw new Error("payment date is required");
  if (proof && proof.mime && !ALLOWED_PROOF[proof.mime]) {
    throw new Error("proof must be an image or PDF");
  }

  const row = await db.one(
    `INSERT INTO payments (partner_slug, amount, paid_on, method, reference, note,
                           proof_mime, proof_bytes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, amount, paid_on`,
    [partnerSlug, round2(amount), p.paidOn, p.method || null, p.reference || null,
     p.note || null, proof ? proof.mime : null, proof ? proof.bytes : null, actor]);

  const after = await summary(partnerSlug);
  await db.query(
    `INSERT INTO audit_log (actor, action, partner_slug, entity, details)
     VALUES ($1,'payment.create',$2,$3,$4)`,
    [actor, partnerSlug, String(row.id),
     JSON.stringify({ amount: round2(amount), paidOn: p.paidOn, method: p.method || null,
                      reference: p.reference || null, balanceAfter: after.balance })]);

  return { id: row.id, summary: after };
}

async function deletePayment(id, actor) {
  const row = await db.one(
    "SELECT partner_slug, amount, paid_on, reference FROM payments WHERE id = $1", [id]);
  if (!row) throw new Error("payment not found");

  await db.query("DELETE FROM payments WHERE id = $1", [id]);
  const after = await summary(row.partner_slug);
  await db.query(
    `INSERT INTO audit_log (actor, action, partner_slug, entity, details)
     VALUES ($1,'payment.delete',$2,$3,$4)`,
    [actor, row.partner_slug, String(id),
     JSON.stringify({ amount: Number(row.amount), paidOn: row.paid_on,
                      reference: row.reference, balanceAfter: after.balance })]);
  return { deleted: true, summary: after };
}

/** Proof attachment for one payment (partner scoping is enforced by the route). */
async function getProof(id) {
  const row = await db.one(
    "SELECT partner_slug, proof_mime, proof_bytes FROM payments WHERE id = $1", [id]);
  if (!row || !row.proof_bytes) return null;
  return { partnerSlug: row.partner_slug, mime: row.proof_mime, bytes: row.proof_bytes };
}

module.exports = { summary, listPayments, addPayment, deletePayment, getProof,
                   totalEarned, totalPaid };
