/*
 * Seed a DEVELOPMENT database with realistic data: the anonymised RDR
 * dataset, a superadmin + admin + owner + partner login, a couple of manual
 * invoices, and one payment — enough to exercise every screen without
 * touching a single row of real data.
 *
 *     node scripts/anonymize.js      (once, or whenever the real file changes)
 *     node scripts/seed-dev.js
 *
 * Safe to re-run: it skips anything that already exists (via db/schema.sql's
 * own idempotency and simple existence checks below).
 *
 * ── the one rule that matters ──────────────────────────────
 * This script creates known passwords and inserts data whose totals will
 * define what you compare against later. NEVER point it at the production
 * database. The production Supabase project ref is hardcoded below and this
 * script refuses to run against it — not a warning, a hard stop — because
 * "seed my dev database" and "overwrite Tatay's real accounts with test
 * passwords" must never be one accidental env-file mixup apart.
 */
require("../src/env").loadEnv();
const db = require("../src/db");
const auth = require("../src/auth");
const partners = require("../src/partners");
const invoices = require("../src/invoices");
const payments = require("../src/payments");
const { anonymize } = require("./anonymize");
const fs = require("fs");
const path = require("path");

const PROD_PROJECT_REF = "vblvgqfbfowdqomdsxc";   // pj-accounting's real Supabase project

function guardNotProduction() {
  const url = process.env.DATABASE_URL || "";
  if (url.includes(PROD_PROJECT_REF)) {
    console.error("\n ✕ REFUSING TO RUN.");
    console.error("   DATABASE_URL points at the PRODUCTION Supabase project.");
    console.error("   This script inserts test accounts with known passwords.");
    console.error("   Point DATABASE_URL at a local or second dev database instead.\n");
    process.exit(1);
  }
  const looksLocal = /localhost|127\.0\.0\.1|host\.docker\.internal/i.test(url);
  if (!looksLocal && !process.env.CONFIRM_SEED) {
    console.error("\n ! DATABASE_URL doesn't look like a local database:");
    console.error("   " + url.replace(/:[^:@]+@/, ":****@"));
    console.error("   If this really is a dedicated dev database, re-run with:");
    console.error("   CONFIRM_SEED=1 node scripts/seed-dev.js\n");
    process.exit(1);
  }
}

async function ensureUser(fields) {
  const existing = await auth.findByEmail(fields.email);
  if (existing) { console.log(`   ${fields.email}: already exists, skipped`); return; }
  await auth.createUser({ ...fields, mustChange: false });
  console.log(`   ${fields.email} / ${fields.password}  (${fields.role})`);
}

async function main() {
  guardNotProduction();
  console.log("Seeding development database...\n");
  await db.init();
  await auth.initSecret();

  const anonPath = path.join(__dirname, "..", "data", "dev", "rdr.anon.json");
  if (!fs.existsSync(anonPath)) { console.log("No anonymised data yet — generating it now."); anonymize(); }
  const dataset = JSON.parse(fs.readFileSync(anonPath, "utf8"));

  console.log("Accounts (all mustChange: false, so you can log straight in):");
  const superEmail = process.env.SUPERADMIN_EMAIL || "shin@dev.local";
  await ensureUser({ email: superEmail, name: "Shin (dev)", role: "admin", password: "dev-super-1" });
  await ensureUser({ email: "admin@dev.local", name: "Dev Admin", role: "admin", password: "dev-admin-1" });
  await ensureUser({ email: "owner@dev.local", name: "Dev Owner", role: "owner", password: "dev-owner-1" });
  await ensureUser({ email: "rdr@dev.local", name: "RDR (dev)", role: "partner", partner: "rdr", password: "dev-partner-1" });

  console.log("\nPartner + dataset:");
  const existing = await partners.getPartner("rdr");
  if (!existing) {
    // Name it "RDR" (not "RDR (dev)") so slugify() lands on "rdr" — matching
    // production and every other reference to this partner in this script.
    const created = await partners.createPartner({ name: "RDR" });
    if (created.slug !== "rdr") throw new Error(`expected slug 'rdr', got '${created.slug}' — a partner named RDR already exists under a different slug?`);
    console.log("   partner 'rdr' created");
  } else {
    console.log("   partner 'rdr' already exists");
  }
  await partners.updatePartner("rdr", { flags: { commission: true, cost: true, margin: false, onelive: false } });
  await partners.saveDataset("rdr", dataset, { fileName: "rdr.anon.json (seeded)" });
  console.log(`   loaded ${dataset.records.length} anonymised rows as the current dataset`);

  console.log("\nManual invoices + a payment (exercises the newer features):");
  const manualNo = "RDR9000001";
  const already = await invoices.getManualInvoice("rdr", manualNo).catch(() => null);
  if (!already) {
    await invoices.createInvoice("rdr", {
      invoice: manualNo, client: "WALK-IN CUSTOMER", date: new Date().toISOString().slice(0, 10),
      items: [{ pjCode: "PJ90001", itemCode: "IC90001", itemType: "RING", supplier: "GOLD",
                weight: 4.2, supplierPrice: 30000, amount: 33000,
                commissionType: "GOLD", commissionRate: "50" }],
    }, "seed-script");
    console.log(`   manual invoice ${manualNo} created`);
  } else {
    console.log(`   manual invoice ${manualNo} already exists`);
  }
  const paid = await payments.listPayments("rdr");
  if (!paid.length) {
    await payments.addPayment("rdr", { amount: 20000, paidOn: new Date().toISOString().slice(0, 10),
      method: "bank transfer", reference: "seed data" }, "seed-script");
    console.log("   one payment of ₱20,000 recorded");
  } else {
    console.log("   payments already exist, skipped");
  }

  const summary = await payments.summary("rdr");
  console.log(`\nDone. Payouts: earned ${summary.earned}, paid ${summary.paid}, balance ${summary.balance}.`);
  console.log(`Log in at http://localhost:5055 as ${superEmail} / dev-super-1\n`);
  process.exit(0);
}

main().catch((e) => { console.error("\n ! seed failed:", e.message); process.exit(1); });
