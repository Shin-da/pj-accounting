# Local development database

Sets you up with a database that behaves exactly like production, holds
realistic data, and can never be confused with the real thing.

## 1. Install Postgres

Windows: https://www.postgresql.org/download/windows/ — the installer asks
for a password for the `postgres` superuser; pick something simple, this is
local-only. Accept the default port (5432).

Confirm it's running — open **SQL Shell (psql)** from the Start menu and
press Enter through the prompts (username `postgres`, the password you set).
If it connects, you're good.

## 2. Create the dev database

In that same psql window:

```sql
CREATE DATABASE pj_dev;
```

## 3. Point the app at it

```
copy .env.example .env
```

Open `.env` and set:

```
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/pj_dev
SUPERADMIN_EMAIL=jeffmathewg@gmail.com
```

`.env` is gitignored — it never gets committed, and `npm start` reads it
automatically from now on. No more `$env:DATABASE_URL=...` before every run.

## 4. Seed it

```
npm run dev:seed
```

This creates the schema, then:

- an **anonymised copy** of the real RDR dataset — same 123 rows, same
  totals, same repeat-client shape, but every client and supplier name is
  replaced with a made-up one. The real names never leave `data/datasets/`.
- four logins, all ready to use immediately (no forced password change):

  | Email | Password | Role |
  |---|---|---|
  | (your `SUPERADMIN_EMAIL`) | `dev-super-1` | admin + superadmin |
  | `admin@dev.local` | `dev-admin-1` | admin |
  | `owner@dev.local` | `dev-owner-1` | owner |
  | `rdr@dev.local` | `dev-partner-1` | partner (RDR) |

- one manual invoice and one payment, so Invoices and Payouts aren't empty
  screens on first login.

Safe to run again any time — it skips anything that already exists. Re-running
adds a new dataset version (the same thing a real Excel re-upload does), so
you can use it to test that manual invoices and payouts survive a re-upload.

## 5. Run it

```
npm start
```

http://localhost:5055 — log in with any of the accounts above.

## Regenerating the anonymised data

If the real Excel changes and you want the dev copy to match its current
shape:

```
npm run dev:anonymize
npm run dev:seed
```

## The one rule

**`DATABASE_URL` in `.env` must always point at `pj_dev` (or another database
you made up), never at the Supabase project Render uses.** `scripts/seed-dev.js`
has a hard check for this — it refuses outright if it detects the real
project's connection string — but the check only catches that one project.
If you ever set up a second cloud database instead of local Postgres, don't
paste production's string in a hurry.
