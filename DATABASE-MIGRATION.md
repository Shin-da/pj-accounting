# Moving pj-accounting to PostgreSQL

The app used to keep everything in JSON files under `data/`. That's why data
vanished on every Render redeploy, and it wouldn't have scaled. It now runs on
PostgreSQL.

---

## What changed

| Before | Now |
|---|---|
| `data/users.json` | `users` table |
| `data/partners.json` | `partners` table |
| `data/datasets/<slug>.json` | `datasets` + `records` tables (one row per line item) |
| `data/proofs/` + index | `proofs` table (image bytes in the DB) |
| `data/logos/` + index | `logos` table (repo fallback in `public/logos/` still works) |
| `data/secret.key` | `settings` table |

Two real gains beyond persistence:

- **Line items are rows, not a JSON blob.** Filtering and totals can move into
  SQL as the data grows instead of loading everything into memory.
- **Upload history is kept.** Each upload creates a new `datasets` row and the
  newest is marked `is_current`, so a bad upload can be identified rather than
  silently overwriting the good one.

---

## 1. Create a database

Use any Postgres. Free tiers that don't expire:

| Provider | Notes |
|---|---|
| **Neon** (recommended) | serverless Postgres, generous free tier, no expiry |
| **Supabase** | Postgres + storage, free tier, pauses after ~1 week idle |
| **Railway** | usage-based, small free credit |
| Local Postgres | for development |

> ⚠️ **Don't use Render's own free Postgres** — it **expires after 30 days** and
> then the data is gone. That's exactly the problem we're fixing.

Copy the connection string it gives you. It looks like:

```
postgresql://user:password@host/dbname?sslmode=require
```

## 2. Set `DATABASE_URL`

**Locally** (PowerShell):
```powershell
$env:DATABASE_URL="postgresql://user:pass@host/db?sslmode=require"
```

**On Render:** service → **Environment** → add `DATABASE_URL`.

The schema is applied automatically on startup, so there's no separate setup
step. (You can also run `psql "$DATABASE_URL" -f db/schema.sql` by hand.)

## 3. Migrate the existing data

From the project folder, with `DATABASE_URL` set:

```
npm install
npm run migrate
```

It reads whatever is in `data/` and loads it into Postgres, then prints what
landed. It's **idempotent** — safe to run again if it fails partway, and it
skips anything already there.

**It does not delete `data/`.** Keep those files until you've confirmed the app
works, then archive them.

## 4. Run

```
npm start
```

Check the numbers match what you had before: **123 rows, ₱2,866,725.43 sales,
₱69,897.42 commission, 40 invoices, 27 clients.**

---

## Verifying after migration

Worth a two-minute check, in this order:

- [ ] Log in with an existing account (the session secret was migrated, so old
      logins still work)
- [ ] Sales register shows **123 rows** and the totals above
- [ ] Invoices list loads; open one and confirm the line items
- [ ] **Open an invoice that has a proof photo and confirm the image displays.**
      Image round-trip is the one thing that couldn't be fully verified in
      testing (the in-memory Postgres used for tests handles `bytea`
      differently from the real thing) — so eyeball it once.
- [ ] Partner logo appears in the header
- [ ] Log in as the RDR partner account and confirm supplier/cost are still hidden
- [ ] Upload a new Excel and confirm it merges into the current dataset (new rows added, unchanged rows left alone, changed rows held for approval) rather than replacing it

---

## Rolling back

Nothing was deleted. If something's wrong:

1. `git checkout` the previous commit (the file-based version), and
2. the `data/` folder is untouched, so the old app works exactly as before.

---

## What to do next (when it grows)

The schema is ready for these; do them when there's a reason, not before:

1. **Push aggregation into SQL.** `loadDataset()` currently reads all rows and
   aggregates in JavaScript — fine for thousands of rows, not for millions.
   The indexes on `txn_date`, `client` and `invoice` are already there.
2. **Move images to object storage** (S3 / Backblaze B2) if proofs grow into
   the thousands, keeping just the URL in the `proofs` table.
3. **Add a rollback button** for uploads — the `datasets` history already
   supports it; it just needs a route and a button.
4. **Nightly `pg_dump` to offsite storage.** The database is now the single
   thing that must be backed up — which is much better than before, but only
   if the backup actually runs.
