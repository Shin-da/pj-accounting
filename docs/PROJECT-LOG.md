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

58 commits, **2026-08-10 → 2026-09-07**, all direct to `main` (no PRs, issues,
tags). ~12,400 insertions / ~1,300 deletions across 207 file-changes. Grouped
into phases below.

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

### Phase 5 — 2026-09-07 · Viewer role, password UX, expenses seed (4 commits)

See the session log entry below for detail.

- `81a0e69` Read-only `viewer` role + first viewer account
- `487fd8e` Show/hide (eye) toggle on password fields (login + change-password)
- `d08971b` Seed the Léspérance partner on boot (expenses feature, step 1) + design doc
- `cc0ab19` Track `CLAUDE.md`; gitignore Syncthing's `.stfolder/` marker

---

## Session log

<!-- newest first -->

### 2026-09-07 — Restrict the Users page to superadmin + owner

**Commits:** `f0daf7d` (pushed to `main`)

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

- **Duplicate empty partners in production** — `migrate` on 2026-09-07 inserted
  `LT` ("LuxeTrust") and `TRI` ("Triara") from `data/partners.json`; the real
  partners are `luxetrust` and `triara` (the latter holds all 8 datasets). `LT`
  and `TRI` are empty. Left in place by choice; delete via SQL if they clutter
  the partner switcher.
- **Two Brandon admin accounts** — `brandongilbert@perfectjewelry.com` (migrated
  2026-09-07) and `garciabrandongilbert@perfectjewelry.com` both exist as
  `admin`. Likely the same person. Left as-is.
- **`.env` line 18** holds a plaintext Supabase connection string incl. password.
  The file is gitignored, but the credential is sitting on disk in cleartext —
  consider whether it should be there.
- **Expenses feature** — only step 1 (partner seed) is done. Steps 2–5 blocked on
  the owner answering the §1/§7 questions in `docs/EXPENSES-DESIGN.md`.
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
