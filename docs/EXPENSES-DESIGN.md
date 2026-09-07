# Design — partner expenses (Léspérance only, for now)

Written before building. The feature is scoped to **one partner** on purpose, so
the design question is as much "how do we keep it from touching everyone else" as
"what does an expense record look like".

---

## 1. What this is

Money that reduces what Perfect Jewel owes **Léspérance** — the partner carries
costs (freight, materials, advances, chargebacks, whatever their arrangement
says) that come off their settlement. No other partner has this: RDR and the
rest are straight commission.

Today the Payouts page ([src/payments.js](../src/payments.js)) shows a running
account:

```
balance payable = commission earned − total paid
```

Expenses add a third term. **Provisional** (owner still confirming the exact
order):

```
balance payable = commission earned − expenses − total paid
```

i.e. expenses are deducted after commission, before/alongside payments. If it
turns out expenses should sit somewhere else in the waterfall, that's a one-line
change in `payments.summary()` — see §4.

---

## 2. How it stays scoped to Léspérance

Reuse the mechanism every other per-partner rule already uses: the
`partners.flags` JSONB.

- New flag: **`expenses`** (boolean, default `false`), alongside
  `commission / cost / margin / onelive` in `DEFAULT_FLAGS`
  ([src/partners.js](../src/partners.js)).
- Léspérance is seeded with `flags.expenses = true`. Nobody else has the key,
  and `!!flags.expenses` is `false` for them.
- `effectiveFlags()` in [src/server.js](../src/server.js) gains
  `expenses: user.role === "partner" ? !!f.expenses : true` (admin/owner always
  see it, same as the other flags).
- Every expenses route starts with `if (!flags.expenses) return 404/403`, so the
  scoping is enforced server-side, not by hiding a nav item.

Why a flag and not a hardcoded slug check: it lives with the other partner
settings, it's visible/toggleable in the Partners admin page, and if a second
partner ever gets the same deal it's a checkbox, not a deploy.

---

## 3. Data model

New table, mirroring `payments` closely (same shape of problem — a per-partner
ledger with proof attachments and an audit trail):

```sql
CREATE TABLE IF NOT EXISTS expenses (
    id            BIGSERIAL PRIMARY KEY,
    partner_slug  TEXT NOT NULL REFERENCES partners(slug) ON DELETE CASCADE,
    amount        NUMERIC(16,2) NOT NULL,          -- always positive; it's a deduction by definition
    spent_on      DATE NOT NULL,
    category      TEXT,                            -- freight / materials / advance / adjustment / other
    description   TEXT,
    reference     TEXT,                            -- OR no., DR no., "against RDR0031-35"
    note          TEXT,
    proof_mime    TEXT,
    proof_bytes   BYTEA,
    created_by    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_expenses_partner ON expenses(partner_slug, spent_on DESC);
```

Goes in [db/schema.sql](../db/schema.sql) (append-only, `IF NOT EXISTS`, applied
on every boot — no migration step).

Deliberately **not** reusing the `records` table: expenses aren't line items,
don't belong to an invoice or a dataset, and must never be touched by an Excel
upload. A separate table keeps that guarantee structural.

---

## 4. Server

New `src/expenses.js`, structured exactly like `payments.js`:

| function | notes |
|---|---|
| `totalExpenses(slug)` | `SUM(amount)` for the partner |
| `listExpenses(slug)` | newest first, proof bytes excluded |
| `addExpense(slug, body, actor, proof)` | validates amount > 0 and a date; writes `audit_log` (`expense.create`) |
| `deleteExpense(id, actor)` | writes `audit_log` (`expense.delete`) |
| `getProof(id)` | for the scoped download route |

`payments.summary()` gains the expenses term:

```js
const expenses = flagsAllowExpenses ? await expensesModule.totalExpenses(slug) : 0;
const balance  = round2(earned - expenses - paid);
return { earned, expenses, paid, balance, status: ... };
```

Routes (all `auth.requireAuth`, all guarded by `flags.expenses`):

- `GET  /api/expenses`            — statement + list; `canRecord` = admin/owner
- `POST /api/expenses`            — admin/owner only (partner is **read-only**)
- `DELETE /api/expenses/:id`      — admin/owner only
- `GET  /api/expense-proof?id=`   — partner may fetch only their own

The partner sees the ledger and the effect on their balance; they cannot add,
edit or delete — same trust model as Payouts.

---

## 5. Frontend

- New nav item **"Expenses"** under Report, rendered only when
  `ME.flags?.expenses` (partner) or always for admin/owner viewing Léspérance.
- Page modelled on `#page-payments`: KPI row (total expenses, and the balance
  now net of them), an add-form card shown only when `canRecord`, and a history
  table with a Remove action + proof thumbnail.
- The Payouts statement gains one line: `− Expenses    ₱x`, so the two pages
  reconcile.

---

## 6. Build order

1. **Seed the Léspérance partner** with `flags.expenses = true` so the deploy
   creates it — *done, see [src/partners.js](../src/partners.js) `seedPartners()`*.
2. `expenses` table in `schema.sql`.
3. `src/expenses.js` + routes + `effectiveFlags` wiring.
4. `payments.summary()` deduction + Payouts statement line.
5. Frontend page + nav gating.

Steps 2–5 wait on the owner confirming the payout waterfall (§1). Step 1 is
independent and safe to ship now — an unused flag on one partner changes
nothing until the rest is built.

---

## 7. Open questions for the owner

1. **Where in the waterfall do expenses sit?** `earned − expenses − paid` is the
   assumption. Alternatives: deducted from the payout at settlement time only,
   or shown as owed-back-to-PJ separately from the commission balance.
2. **Can a partner's expenses exceed their commission** (negative balance = the
   partner owes PJ)? The formula allows it; the UI should probably call it out.
3. **Categories** — is there a fixed list Léspérance uses, or free text?
4. **Proof required** on every expense, or optional like payments?
5. Does Léspérance ever need to *see a breakdown by category*, or just the total?
