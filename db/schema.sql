-- =====================================================================
-- pj-accounting — PostgreSQL schema
--
-- Replaces the JSON files under data/. Run once against your database:
--     psql "$DATABASE_URL" -f db/schema.sql
-- The app also applies this automatically on startup (see src/db.js),
-- so you normally don't need to run it by hand.
--
-- Safe to re-run: everything is IF NOT EXISTS.
-- =====================================================================

-- ── accounts ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL,                      -- admin | owner | partner
    partner_slug  TEXT,                               -- only for role = partner
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    disabled      BOOLEAN NOT NULL DEFAULT FALSE,
    must_change   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Archived accounts stay in the table forever. `audit_log.actor` and
-- `records.created_by` store an email as free text, so hard-deleting a user
-- would leave the trail naming somebody the system no longer knows. In an
-- accounting system "who recorded this payment" has to keep an answer.
ALTER TABLE users ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS archived_by TEXT;

-- ── partners ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS partners (
    slug        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    -- what a partner user is allowed to see: commission / cost / margin / onelive
    flags       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── uploads ──────────────────────────────────────────────────────────
-- One row per Excel upload. Keeping history means we can see what a
-- report looked like at a point in time, and roll back a bad upload.
CREATE TABLE IF NOT EXISTS datasets (
    id           BIGSERIAL PRIMARY KEY,
    partner_slug TEXT NOT NULL REFERENCES partners(slug) ON DELETE CASCADE,
    file_name    TEXT,
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    uploaded_by  TEXT,
    is_current   BOOLEAN NOT NULL DEFAULT TRUE,
    meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- The original .xlsx, kept so any past upload can be downloaded or
    -- re-parsed later. ~75 KB each; move to object storage if this grows.
    file_bytes   BYTEA,
    file_mime    TEXT
);
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS file_bytes BYTEA;
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS file_mime  TEXT;
CREATE INDEX IF NOT EXISTS idx_datasets_partner ON datasets(partner_slug, is_current);

-- ── the actual line items ────────────────────────────────────────────
-- Real rows, not a JSON blob: this is what lets filtering and totals move
-- into SQL as the data grows.
CREATE TABLE IF NOT EXISTS records (
    id                BIGSERIAL PRIMARY KEY,
    -- NULL for manually-created rows: they belong to the partner, not to an
    -- upload, so a new Excel upload can never delete them.
    dataset_id        BIGINT REFERENCES datasets(id) ON DELETE CASCADE,
    partner_slug      TEXT   NOT NULL,
    -- 'import' = came from an Excel upload (replaced on re-upload)
    -- 'manual' = created in the app  (never touched by uploads)
    source            TEXT   NOT NULL DEFAULT 'import',
    row_no            INTEGER,
    txn_date          DATE,
    invoice           TEXT,
    client            TEXT,
    pj_code           TEXT,
    item_code         TEXT,
    item_type         TEXT,
    supplier          TEXT,
    weight            NUMERIC(14,3)  DEFAULT 0,
    capital_per_gram  NUMERIC(14,2)  DEFAULT 0,
    supplier_price    NUMERIC(16,2)  DEFAULT 0,
    amount            NUMERIC(16,2)  DEFAULT 0,
    onelive           NUMERIC(16,2)  DEFAULT 0,
    commission        TEXT,                    -- the rate as written (e.g. "5%" or 50)
    commission_type   TEXT,                    -- GOLD | JEWELRY
    commission_value  NUMERIC(16,2)  DEFAULT 0,
    sheet             TEXT,
    seller_status     TEXT                     -- PAID | UNPAID, from the client's own sheet
);
-- Columns added after the first release, applied so an existing database is
-- upgraded in place when the app starts.
--
-- ORDER MATTERS: these must run BEFORE any index that references them. On a
-- fresh database CREATE TABLE above already includes the columns, but on an
-- existing one the table is left alone — so indexing `source` before adding it
-- fails with: column "source" does not exist.
ALTER TABLE records ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'import';
ALTER TABLE records ALTER COLUMN dataset_id DROP NOT NULL;
ALTER TABLE records ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE records ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE records ADD COLUMN IF NOT EXISTS seller_status TEXT;

CREATE INDEX IF NOT EXISTS idx_records_dataset  ON records(dataset_id);
CREATE INDEX IF NOT EXISTS idx_records_partner  ON records(partner_slug);
CREATE INDEX IF NOT EXISTS idx_records_date     ON records(txn_date);
CREATE INDEX IF NOT EXISTS idx_records_invoice  ON records(invoice);
CREATE INDEX IF NOT EXISTS idx_records_client   ON records(client);
CREATE INDEX IF NOT EXISTS idx_records_source   ON records(partner_slug, source);

-- ── audit trail ──────────────────────────────────────────────────────
-- Every write that a person makes, so "who changed this and when" always
-- has an answer. Cheap to write, invaluable the first time it's disputed.
CREATE TABLE IF NOT EXISTS audit_log (
    id           BIGSERIAL PRIMARY KEY,
    at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor        TEXT,                -- email of the signed-in user
    action       TEXT NOT NULL,       -- invoice.create | invoice.update | invoice.delete | upload | ...
    partner_slug TEXT,
    entity       TEXT,                -- e.g. the invoice number
    details      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_audit_partner ON audit_log(partner_slug, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_log(entity);

-- ── images ───────────────────────────────────────────────────────────
-- Stored in the database so there is ONE thing to back up and nothing to
-- lose on redeploy. If these ever grow large, move them to object storage
-- (S3 / Backblaze B2) and keep only the URL here.
CREATE TABLE IF NOT EXISTS proofs (
    partner_slug TEXT NOT NULL REFERENCES partners(slug) ON DELETE CASCADE,
    reserve      TEXT NOT NULL,
    mime         TEXT NOT NULL,
    bytes        BYTEA NOT NULL,
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (partner_slug, reserve)
);

CREATE TABLE IF NOT EXISTS logos (
    partner_slug TEXT PRIMARY KEY REFERENCES partners(slug) ON DELETE CASCADE,
    mime         TEXT NOT NULL,
    bytes        BYTEA NOT NULL,
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── commission payouts ───────────────────────────────────────────────
-- Money flowing FROM Perfect Jewel TO the partner.
--
-- A payment belongs to the PARTNER, not to an invoice: in practice a single
-- transfer settles many invoices at once. So this is a running account —
--
--     balance payable  =  total commission earned  −  total paid
--
-- `reference` is free text (an OR number, a transfer ref, or "covers RDR0031-35")
-- so a payment CAN be described against invoices without being bound to one.
CREATE TABLE IF NOT EXISTS payments (
    id           BIGSERIAL PRIMARY KEY,
    partner_slug TEXT NOT NULL REFERENCES partners(slug) ON DELETE CASCADE,
    amount       NUMERIC(16,2) NOT NULL,
    paid_on      DATE NOT NULL,
    method       TEXT,                       -- bank transfer / cash / cheque / ...
    reference    TEXT,                       -- OR no., transfer ref, invoices covered
    note         TEXT,
    proof_mime   TEXT,                       -- optional proof of payment image
    proof_bytes  BYTEA,
    created_by   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_partner ON payments(partner_slug, paid_on DESC);

-- ── app settings (session secret, etc.) ──────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
