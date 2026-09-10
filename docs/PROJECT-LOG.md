# Project Log — pj-accounting

Working log for **Perfect Jewel — Partner Sales & Accounting**. Reconstructed
from git history on 2026-09-07 (the project had no log before this), then kept
up per session going forward.

## How to maintain this

- **Development history** below is the phased summary of git commits. Regenerate
  or extend it from `git log --date=short --pretty=format:'%h|%ad|%an|%s'`.
- **Session log** is the running record. Add a new entry at the **top** of that
  section after each working session — what changed, why, decisions made, and
  anything left open. A template is at the very bottom.
- **Open items** tracks known issues and follow-ups so they don't get lost
  between sessions. Move things out of it when done (note which session closed
  them).

## Related docs

| Doc | What it covers |
|---|---|
| [README.md](../README.md) | What the app is, how to run it, the Excel format, deploy |
| [DATABASE-MIGRATION.md](../DATABASE-MIGRATION.md) | The JSON-files → PostgreSQL move and what it changed |
| [docs/DEV-SETUP.md](DEV-SETUP.md) | Local Postgres + anonymised dev database + seed logins |
| [docs/DATA-MODEL-DESIGN.md](DATA-MODEL-DESIGN.md) | Source-of-truth decision for uploads vs. in-app editing |
| [docs/EXPENSES-DESIGN.md](EXPENSES-DESIGN.md) | Per-partner expenses ledger (Léspérance), design written before build |

---

## Project overview

A multi-user accounting dashboard for Perfect Jewel's partner sales and
commission, fed by Excel uploads. Accounting admins upload each partner's sheet;
partners see only their own report with admin-controlled column visibility; the
owner sees a read-only portfolio across all partners.

- **Stack:** Node.js + Express, SheetJS (Excel parsing), Chart.js (charts),
  PostgreSQL (Neon/Supabase/Render/local all work). Pure JavaScript, no build step.
- **Auth:** scrypt-hashed passwords, signed-cookie sessions (stateless), roles
  enforced server-side.
- **Deploy:** Render (`render.yaml`), off `main`. `DATABASE_URL` set in the
  dashboard; the current shared database is a Supabase project.
- **Roadmap direction:** view-only Excel dashboard → accounts + persistent DB →
  direct data entry (invoices, expenses) → full accounting system, no Excel.

### Roles

| Role | Can |
|---|---|
| `admin` | Uploads, manual invoices, payouts, partner administration. Still authorised to create/manage **partner** accounts via the API, but the Users page/nav is no longer shown to them (superadmin + owner only) |
| `owner` | Read-only portfolio across all partners; also records payouts; sees the Users page read-only (the only non-superadmin who can) |
| `partner` | Own report only, columns gated by `partners.flags` |
| `viewer` | Sees everything an admin sees except the Users page — Partners page and portfolio read-only; every write route stays admin-only |
| superadmin | Pinned to `SUPERADMIN_EMAIL` in the env, not a row. Only they manage admin/owner accounts and only they (plus `owner`, read-only) see the Users page; their own account can't be changed from the app |

### Source layout

```
src/server.js      Express app + all routes
src/auth.js        accounts, roles, sessions, superadmin rules, seeding
src/db.js          pg pool, schema apply, connection-string diagnostics
src/parse.js       Excel → records, column aliasing, aggregation/KPIs
src/partners.js    partner CRUD, flags, datasets, BUILTIN_PARTNERS seed
src/invoices.js    manual invoices + audit log
src/payments.js    commission payouts (earned − paid = balance)
src/proofs.js      proof image storage
src/logos.js       partner logos
src/migrate.js     one-off JSON (data/) → PostgreSQL
src/env.js         dependency-free .env loader
config.js          port, currency, Excel column alias map
db/schema.sql      applied on every boot, IF NOT EXISTS / append-only
public/            index.html, login.html, maintenance.html, app.js, style.css
test/              preflight (role leaks), superadmin, ui-smoke, maintenance-ui
scripts/           anonymize.js, seed-dev.js
```

---

## Development history

62 commits, **2026-08-10 → 2026-09-07**, all direct to `main` (no PRs, issues,
tags; a `backup-original-main` branch exists as a safety copy). ~12,700
insertions / ~1,300 deletions across 216 file-changes. Grouped into phases below.

### Phase 1 — 2026-08-10 · Excel dashboard foundation (14 commits)

- `623c177` Initial: RDR report as a multi-user dashboard — accounts, roles, partner scoping
- `b04d14a` Renamed to **pj-accounting**; neutral Perfect Jewel branding, RDR becomes one partner
- `70df46f` `cecbc7c` `3b1d13c` Invoices: clickable list, item breakdown, per-invoice proof image (admin upload); `[hidden]` CSS fix
- `6a14eeb` `63213c2` Admin/owner report groups by commission type; env-driven account seeding; **partner scoping hardened** — supplier hidden everywhere, server-enforced, item-type no longer leaks supplier
- `713635a` `699b048` `52f3659` Excel green-column mapping (INVOICE NO. rename, selling-based commission, commission rate exposed); "Selling price" → "Item amount"; money shown to 2 decimals
- `d0fa1ac` Ingest only complete master sheet(s) — dropped stub tabs that double-counted (123 rows now matches Excel)
- `6a0e2c9` `9a1d6ef` Register/invoice polish (row numbers, N/A for blanks); global persistent filters (search / commission type / client) applied server-side; sortable columns; totals row
- `eb011be` Rebrand to "Secret Supplier"; partner logo replaces PJ mark, with committed repo fallback

### Phase 2 — 2026-08-11 · PostgreSQL, payouts, security hardening (16 commits)

- `6df7ccb` **Storage moved from JSON files to PostgreSQL** (users, partners, records, proofs, logos) with upload history + migration script
- `523546e` `/api/health` queries the DB so the keep-alive ping also keeps Postgres awake
- `4935adf` `bcce905` `1801b52` Manual invoices — admins create/edit in-app (`source=manual`), survive Excel re-uploads, auto-calculated commission, collision warnings, stored source files, audit trail; schema upgrade-order fix; duplicate element-id fix
- `451a5d3` `d515fe0` Commission payouts: partner-level running account (earned − paid = balance payable), lump-sum payments with proof attachments, partner sees balance read-only; fixed double-counting (earned must come from current dataset + manual rows only)
- `a01a850` `af80eb7` UI: wider invoice editor with sticky header/footer, fitted line-item columns, drill-downs from register/breakdowns/charts, active-filter chips, attribute-safe escaping; theme-aware colour system (fill vs. text tokens, chart series as CSS variables so dark mode recolours, gold = GOLD accent)
- `ac5565a` **Pre-flight role/data-leak test** — boots the real server, asserts partners can't read or write anything outside their scope
- `ad9becc` `36f5b87` Superadmin pinned to `SUPERADMIN_EMAIL`: only they manage admin/owner accounts, their own account is untouchable from the app; **archive replaces delete** so the audit trail survives; superadmin-only hard delete requires the exact email + reports account history first
- `911df41` `fdd3b85` `af9ad23` `ef43e52` Validate `DATABASE_URL` before connecting (name the paste error, not a DNS failure); catch shell-syntax pastes (`$env:`, `export`, `set`); fix test paths; guard listener attachments with optional chaining

### Phase 3 — 2026-08-12 · Deploy reliability + dev setup (7 commits)

- `5b43155` Dependency-free `.env` loader at startup + `.env.example`
- `5ad9cbe` Dev database setup: anonymised copy of the real dataset, seed script with four ready logins, hard guard that refuses to run against the production Supabase project
- `31da645` Translate common Postgres connection errors (not running, wrong password, missing DB) into readable messages; stop `process.exit()` right after a write (truncated output on Windows)
- `a35246f` **Fixed the stuck Render deploy** — the server only opened its port *after* connecting to the DB, so an unreachable DB meant no port ever opened and Render restarted forever. Now: port opens first, DB connects in the background with retry+backoff, an unreachable DB auto-triggers maintenance mode, and the maintenance page polls `/api/health` and jumps back when ready
- `5544cc8` `c41dbae` `7bb23ed` Maintenance page: fixed the bounce bug (a real maintenance window no longer claims "back online" just because the DB is healthy), track `downSince` and show real elapsed time, redesign to match the app, document its test

### Phase 4 — 2026-08-18 → 08-26 · Fixes + staff accounts (18 commits)

- `fac8b21` (08-18) Fixed Excel uploads loading every row with a blank date
- `d044487` (08-21) Add staff accounts; update accent colors
- `d122172` `a96304b` (08-21) File uploads via GitHub web UI
- `3cfdb91` `a08d620` (08-21) Show PJ logo for admin/owner/superadmin and partner logo for partner accounts; header brand name follows the viewed partner; drop Supplier from report tables
- `63ea90b` (08-21) Recognise `SELLER STATUS` (PAID/UNPAID) as a standard upload column
- `e6f7c12` `dfddbaf` `026b221` (08-21) Sidebar footer keeps the update date, drops the filename; dynamic tab title + favicon per logged-in user, fix misnamed logo files; trends chart fix (undated rows created a nonsense first data point)
- `e053efe` `3dfe09f` `9ad8341` `0f710b9` (08-21) "Updates" — login page and maintenance page markup tweaks
- `1432d9f` (08-21) Shared-link preview shows "Perfect Jewelry Partners", not "Secret Supplier"
- `314b75f` (08-26) A real Remove-proof action for invoice proofs

### Phase 5 — 2026-09-07 · Viewer role, password UX, expenses seed, Users-page lockdown (8 commits)

See the session log entries below for detail.

- `81a0e69` Read-only `viewer` role + first viewer account
- `487fd8e` Show/hide (eye) toggle on password fields (login + change-password)
- `d08971b` Seed the Léspérance partner on boot (expenses feature, step 1) + design doc
- `cc0ab19` Track `CLAUDE.md`; gitignore Syncthing's `.stfolder/` marker
- `ac24fc1` Add this project log (`docs/PROJECT-LOG.md`), reconstructed from git history
- `3792eaf` Restrict the Users page to the superadmin and owners
- `d85603b` Correct a commit hash in a PROJECT-LOG entry
- `0ca4cc6` PROJECT-LOG: session entry for the Supabase duplicate-partner cleanup

Plus non-commit work the same day: two duplicate partner rows deleted from the
Supabase database — see the top session-log entry. (This log's own update
commits always trail the running count by one until the next edit.)

---

## Session log

<!-- newest first -->

### 2026-09-10 — Isolation audit + partner-switch hardening

**Commits:** `<this commit>` (pushed to `main` → Render redeploy)

**Isolation audit (no code change — verified airtight)**
- Built a 40-assertion test (partner users Alpha/Bravo + admin, scratch DB) and
  confirmed: a partner hitting `/api/report|invoices|invoice?partner=<other>`
  gets **their own** data (`resolvePartner` ignores `?partner=` for the partner
  role); supplier names / cost / margin / ONELIVE never appear in a partner
  payload; `invoice-proof`, `payment-proof`, `expense-proof` all 403 across
  partners; `/api/expenses` 403s without `flags.expenses`; `portfolio`,
  `dataset-file`, `audit`, `users`, `partners` and every write route 403 for
  partners. "Per supplier" = supplier *names*, which are stripped everywhere a
  partner can reach and excluded from partner search — unchanged, still holds.

**Hardening (staff partner/supplier switching — speed + accuracy)**
- **Stale-response guard** ([public/app.js](../public/app.js)): a `viewGen`
  counter, bumped on every partner/filter change; `load`, `loadInvoices`,
  `loadPayments`, `loadExpenses` capture it and drop their response if a newer
  switch happened first. Fixes fast A→B switching painting A's numbers under B.
- **Parallelised DB round-trips**: `payments.summary()` runs its three
  aggregates with `Promise.all` (was 3 sequential hops to Singapore);
  `/api/portfolio` fans out the per-partner dataset load+aggregate instead of a
  blocking loop. Verified numbers identical.
- **`resolvePartner`**: a staff request with an explicit unknown `?partner=`
  slug now returns `null` → `/api/report` responds `404 {empty, reason:"partner
  not found"}` instead of silently falling back to the first partner and showing
  its numbers under the wrong name. An absent slug still defaults to the first.

**Open / follow-ups**
- **Cold start**: Render free instance spins down after ~15 min idle (~50 s
  first request). Confirm an external keep-alive pings `/api/health` (it runs a
  real DB query, so it keeps Supabase warm too) or accept the cold hit.
- Optional: short-TTL client cache of report payloads for instant switch-back.

---

### 2026-09-10 — Partner expenses ledger (Léspérance) — build steps 2–5

**Commits:** `<this commit>` (pushed to `main` → Render redeploy)

**What changed**
- **`expenses` table** in [db/schema.sql](../db/schema.sql) — per-partner ledger
  mirroring `payments` (amount, spent_on, category, description, reference, note,
  proof bytes, created_by), applied on boot like the rest of the schema.
- **[src/expenses.js](../src/expenses.js)** (new) — `totalExpenses` /
  `listExpenses` / `addExpense` / `deleteExpense` / `getProof`. `totalExpenses`
  JOINs `partners` and filters on `flags->>'expenses'`, so a stray row for an
  unflagged partner contributes 0 to any balance — the scoping is structural,
  not just route-level.
- **`payments.summary()`** now returns `{ earned, expenses, paid, balance,
  status }` with `balance = earned − expenses − paid`. New `status: "credit"`
  when expenses + paid exceed commission (partner owes PJ). Backward-compatible:
  `expenses` is 0 for every partner without the flag, so RDR/LuxeTrust/Triara
  are unchanged.
- **Routes** in [src/server.js](../src/server.js): `GET/POST/DELETE
  /api/expenses` + `GET /api/expense-proof`. Reads need `flags.expenses`
  (403 otherwise); writes are admin/owner **and** re-check the partner flag
  server-side. `effectiveFlags()` gains `expenses` for every role (tracks the
  partner flag even for admin/owner). `/api/me` now includes each partner's
  `flags` so the frontend can gate the nav on partner switch.
- **Frontend**: "Expenses" nav item + `#page-expenses` (KPI row, add-form,
  history table) modelled on Payouts. `syncExpensesNav()` shows/hides it per
  current partner. Payouts KPIs and the Overview "Balance payable" card show the
  `− expenses` term when non-zero. `Carries expenses` checkbox added to the
  Partners admin page.
- [docs/EXPENSES-DESIGN.md](EXPENSES-DESIGN.md) updated to "built" with the
  decisions recorded.

**Decisions** (owner hadn't answered §7; built with the assumption, each a small
change to reverse)
- Waterfall position: `earned − expenses − paid` (one line in `summary()`).
- Categories: fixed pick-list (materials / labor / transport / food / advance /
  adjustment / other), matching the Sept-2026 Léspérance breakdown.
- Proof: optional, like payments.
- Negative balance allowed; UI labels it "partner owes PJ" (`status: "credit"`).

**Testing** — against a throwaway local Postgres DB (created + dropped; prod
`.env` untouched): 22-assertion module smoke test green (flag scoping, the
`earned − expenses − paid` math, `credit` status, proof bytes excluded from
list, delete restores balance, audit rows). Authenticated HTTP round-trip:
`GET/POST` 200 for `lesperance`, 403 for `rdr`; `DELETE` 200; `/api/me` carries
flags.

**Open / follow-ups**
- Owner to confirm the four §7 decisions above.
- Léspérance's actual Sept-2026 expense rows still need entering (the
  `LESPERANCE EXPENSES.xlsx` breakdown); row 7 stickers are shared with Jinkee
  and need an allocation before entry.

---

### 2026-09-07 — Remove duplicate partners from Supabase; redeploy-persistence check

**Commits:** none (production-DB cleanup + a gitignored file; this log update is
the only committed artifact).

**What changed**
- **Deleted the duplicate partner rows `LT` and `TRI` from the Supabase
  (production) database.** These were the empty "LuxeTrust" / "Triara" rows that
  the earlier `npm run migrate` had created alongside the real `luxetrust` /
  `triara`. Each was verified to have zero datasets, records, users, payments,
  proofs, and logos, then deleted inside a guarded transaction that aborts if any
  attached data is found. Supabase partners are now exactly `rdr`, `luxetrust`,
  `triara`, `lesperance` — the Portfolio page and partner switcher no longer show
  repeats.
- Removed the `LT` / `TRI` entries from `data/partners.json` (untracked /
  gitignored) so a future `npm run migrate` won't reintroduce them. The file now
  lists only `rdr`; the real partners live in the DB.
- No application code changed.

**Q&A captured**
- Confirmed that accounts created and passwords changed **through the app** persist
  across Render redeploys: writes go to Supabase (external), and the Render
  instance disk holds no user data since the Aug-11 PostgreSQL migration. The
  `render.yaml` comment that still says "uploaded data + accounts reset on each
  redeploy" is stale — see Open items.

**Follow-ups**
- Optionally clean up the two Brandon admin accounts (still open, below).

---

### 2026-09-07 — Restrict the Users page to superadmin + owner

**Commits:** `3792eaf` (pushed to `main`)

**What changed**
- `public/index.html`: the Users nav item is tagged `data-users-nav` (was
  `data-admin`), so it is gated independently of the Partners nav.
- `public/app.js` `boot()`: new `canSeeUsers = superadmin || role === "owner"`
  toggles `[data-users-nav]`. `[data-admin]` (now just the Partners nav) is
  unchanged — still admin + viewer. Stale role comments updated; `loadUsers()`
  comment now says "owner" instead of "viewer".
- `src/server.js`: `GET /api/users` gate tightened from
  `requireRole("admin", "viewer")` to `requireRole("owner")` (superadmin passes
  every gate). Mutating `/api/users` routes are unchanged — still
  `requireRole("admin")` plus the per-account guards in `auth.js`, so a plain
  admin keeps partner-account management via the API even though the page is
  hidden. An `owner` hitting the roster gets `canManage: false` → read-only.
- `test/preflight.js`: viewer "CAN read the user list" assertions replaced with
  "blocked from /api/users"; added an admin-blocked check and an owner block
  (can read, `canManage` false, cannot POST).
- `test/superadmin.js`: the archived-list checks now run as the superadmin
  (`sc`) instead of the ordinary admin (`ac`); added "ordinary admin CANNOT read
  the user list" and "owner CAN read the user list".
- All four suites pass.

**Decisions**
- Kept the write routes at `admin`. Restricting them to owner/superadmin would
  strip a plain admin's existing ability to manage partner accounts, which
  wasn't asked for. The change is about who *sees* the page.

**Resolves** the "Users nav gating" open item from the previous session.

---

### 2026-09-07 — Viewer role, password eye toggle, Léspérance seed

**Commits:** `81a0e69`, `487fd8e`, `d08971b`, `cc0ab19` (all pushed to `main`)

**1. New `viewer` role** — "like an admin but read-only"
- `src/auth.js`: `"viewer"` added to `ROLES`; not privileged, so any admin can
  create/manage viewer accounts (not superadmin-gated like admin/owner).
- `src/server.js`: `"viewer"` added to the read gates on `/api/portfolio`,
  `/api/partners` (GET), `/api/partners/:slug/datasets`, `/api/dataset-file`,
  `/api/audit`, `/api/users` (GET). `/api/users` GET now also returns
  `canManage`. Every mutating route is unchanged — a viewer gets 403 on writes,
  uploads and user management. Report/invoice/payment data is unscoped for any
  non-`partner` role, so a viewer sees supplier/cost/margin/ONELIVE like an admin.
- `public/app.js` + `public/index.html`: viewer gets the full admin nav
  (Overview, Register, Invoices, Payouts, Portfolio, Partners, Users); Partners
  and Users render read-only (checkboxes disabled, logo upload / "Add a partner"
  / "Add a user" hidden, no row action buttons); "Viewer" added to the role picker.
- `test/preflight.js`: 15 viewer assertions added — can read portfolio / users /
  partners / audit / dataset history, `canManage` is false, cannot record a
  payment / create an invoice / change flags / create a user / upload.
- All four suites pass.

**2. First viewer account** — YLA MAE G. GONZALES (Marketing Head)
- Email `perfectjewelryadmin@al-marcorp.com`, role `viewer`, `mustChange: true`.
- Appended to `data/users.json` (following the existing hand-added pattern), then
  **`npm run migrate` run against the Supabase database** to insert it. Verified
  in the live DB; authenticates with its temp password.
- Temp password was handed over out-of-band (not recorded here).

**3. Password show/hide (eye) toggle**
- Reusable `.pw-field` / `.pw-eye` pattern in `public/style.css` (button overlaid
  inside the input, icon swaps eye ↔ eye-off).
- Wired on the login page (`public/login.html`, inline script) and both fields of
  the Change-password modal (`public/index.html` + `wirePwToggles()` in
  `public/app.js`). Verified in a browser.

**4. Léspérance partner seed (expenses feature, step 1)**
- `src/partners.js`: `BUILTIN_PARTNERS` + `ensurePartner()` + `seedPartners()` —
  insert-if-missing on startup, existing partners never clobbered. `expenses`
  key added to `DEFAULT_FLAGS` (default false). `src/server.js` calls
  `partners.seedPartners()` in `connectDb()`.
- `docs/EXPENSES-DESIGN.md` committed. Steps 2–5 (table, routes, UI) wait on the
  owner confirming the payout waterfall — this step is safe to ship because an
  unused flag on one partner changes nothing.
- *Note: this work predated the session in the working tree; it was reviewed,
  tested, and committed here.*

**5. Housekeeping**
- `CLAUDE.md` (git commit conventions: no AI attribution) is now tracked.
- `.stfolder/` (Syncthing marker) added to `.gitignore`.

**Side effects to be aware of:** running the full `npm run migrate` also pushed
other pending `data/` entries into the Supabase DB — see Open items.

---

## Open items

- ~~**Duplicate empty partners in production**~~ — RESOLVED 2026-09-07. `migrate`
  had inserted empty `LT` ("LuxeTrust") and `TRI` ("Triara") from
  `data/partners.json` alongside the real `luxetrust` / `triara`. Both had zero
  datasets/records/users/logos; deleted from Supabase via a guarded transaction,
  and the `LT` / `TRI` entries removed from `data/partners.json` so a future
  `migrate` won't reintroduce them. Supabase partners are now `rdr`, `luxetrust`,
  `triara`, `lesperance`.
- **Two Brandon admin accounts** — `brandongilbert@perfectjewelry.com` (migrated
  2026-09-07) and `garciabrandongilbert@perfectjewelry.com` both exist as
  `admin`. Likely the same person. Left as-is.
- **Stale `render.yaml` comment** — it still says "the free plan has NO
  persistent disk, so uploaded data + accounts reset on each redeploy". That has
  been false since the 2026-08-11 PostgreSQL migration; all data lives in
  Supabase now. Delete or rewrite the comment so it doesn't mislead.
- **`.env` line 18** holds a plaintext Supabase connection string incl. password.
  The file is gitignored, but the credential is sitting on disk in cleartext —
  consider whether it should be there.
- **Expenses feature** — built and deployed 2026-09-10 (steps 1–5). Owner still
  to confirm the four §7 decisions (waterfall position, category list, optional
  proof, negative-balance handling) — all recorded in `docs/EXPENSES-DESIGN.md`
  and each a small change to reverse. Léspérance's real expense rows not yet
  entered; row 7 (stickers) is shared with Jinkee and needs an allocation first.
- **Viewer account persistence** — the account is in the Supabase DB now. If the
  DB is ever rebuilt from `data/`, `data/users.json` carries it; otherwise that
  file is just a backup.

---

## Session entry template

```markdown
### YYYY-MM-DD — <short title>

**Commits:** `<hashes>` (pushed to `main` / not pushed)

**What changed**
- ...

**Decisions**
- ...

**Open / follow-ups**
- ...
```
