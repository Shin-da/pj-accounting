# Design — partner expenses (Léspérance only, for now)

Written before building. The feature is scoped to **one partner** on purpose, so
the design question is as much "how do we keep it from touching everyone else" as
"what does an expense record look like".

> **Status (2026-09-10): built.** Steps 1–5 below are done — `expenses` table,
> `src/expenses.js`, routes, `payments.summary()` deduction, and the Expenses
> page. Decisions taken where the owner hadn't answered §7: waterfall is
> `earned − expenses − paid` (the assumption); categories are free-ish (a fixed
> pick-list: materials / labor / transport / food / advance / adjustment /
> other); proof is optional; a balance may go negative and the UI labels that
> "partner owes PJ" (`status: "credit"`). Any of these is a small change if the
> owner decides otherwise — see the notes inline.

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

1. ~~**Seed the Léspérance partner** with `flags.expenses = true`~~ — done,
   [src/partners.js](../src/partners.js) `seedPartners()` / `BUILTIN_PARTNERS`.
2. ~~`expenses` table in `schema.sql`~~ — done, [db/schema.sql](../db/schema.sql).
3. ~~`src/expenses.js` + routes + `effectiveFlags` wiring~~ — done.
   `effectiveFlags` now returns `expenses` off the partner flag for every role,
   so admin/owner only see the tab on a partner that carries them.
4. ~~`payments.summary()` deduction + Payouts statement line~~ — done. `summary()`
   returns `{ earned, expenses, paid, balance, status }`; the Payouts KPI row and
   the Overview "Balance payable" card show the `− expenses` term when non-zero.
5. ~~Frontend page + nav gating~~ — done. `#page-expenses`, `loadExpenses()`,
   `syncExpensesNav()` (re-runs on partner switch), `expenses` checkbox on the
   Partners admin page. `/api/me` now ships each partner's `flags` for the gate.

If the owner moves the waterfall (§1), it's the one line in `payments.summary()`.

---

## 7. Open questions for the owner

Built with the assumption in each case; revisit if the owner disagrees.

1. **Where in the waterfall do expenses sit?** Built as `earned − expenses −
   paid`. Alternatives: deducted at settlement time only, or tracked as
   owed-back-to-PJ separately from the commission balance. → one line in
   `payments.summary()`.
2. **Can expenses exceed commission** (negative balance)? **Yes** — `summary()`
   returns `status: "credit"` and the UI shows "partner owes PJ ₱x".
3. **Categories** — shipped as a fixed pick-list (materials / labor / transport
   / food / advance / adjustment / other), matching the Sep 2026 breakdown.
   Free text instead = drop the `<select>` for an `<input>`.
4. **Proof** — optional, like payments.
5. **Breakdown by category for Léspérance?** Not built — the page shows the
   per-row category and a total. A category subtotal strip is easy to add if
   they want it.
