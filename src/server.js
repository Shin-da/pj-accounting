/*
 * Perfect Jewel — partner sales & accounting server.
 *
 * Roles: admin (upload + manage users/partners + see all), owner (read-only
 * portfolio across all partners incl. ONELIVE profit), partner (own report
 * only, filtered by that partner's visibility flags).
 *
 * Data is scoped SERVER-SIDE: a partner can never pull another partner's data
 * or a hidden field, no matter what the client asks for.
 *
 * Storage is PostgreSQL (see src/db.js). Every handler is async because of it.
 */

// Load .env first: everything below reads process.env at require time.
require("./env").loadEnv();
const path = require("path");
const express = require("express");
const multer = require("multer");

const { PORT, CURRENCY, MAINTENANCE_MODE, MAINTENANCE_MESSAGE } = require("../config");
const { parseWorkbookBuffer, aggregate, groupInvoices } = require("./parse");
const db = require("./db");
const auth = require("./auth");
const partners = require("./partners");
const proofs = require("./proofs");
const logos = require("./logos");
const invoices = require("./invoices");
const payments = require("./payments");

/** Wrap an async handler so a thrown error becomes a 500 instead of a hang. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: false }));
/* ── database readiness ───────────────────────────────────
 * Defaults to true so requiring this module directly (as the test suites
 * do — they call db.init() themselves and never call start()) behaves
 * exactly as before: no test needs to know this flag exists.
 *
 * In production, start() flips this to false if the database can't be
 * reached, which is what puts the site into maintenance mode automatically
 * — see the note on start() for why this matters.
 */
let dbReady = true;
let dbError = null;
let downSince = null;   // when the CURRENT outage started, or null if up

/** Both connectDb() and /api/health can detect a transition — funnel state
 *  changes through here so downSince can't drift out of sync between them. */
function markDbDown(reason) {
  if (dbReady) downSince = new Date().toISOString();   // only stamp the FIRST failure of a streak
  dbReady = false;
  dbError = reason;
}
function markDbUp() {
  const wasDown = !dbReady;
  dbReady = true; dbError = null; downSince = null;
  return wasDown;
}

app.use(auth.attachUser);
app.use((req, res, next) => {
  // Maintenance shows for two reasons: someone deliberately turned it on
  // (MAINTENANCE_MODE), or the database is unreachable (dbReady is false).
  // Visitors see the same friendly page either way — the real reason is
  // only in the server log and /api/health, never in the public response.
  if (!MAINTENANCE_MODE && dbReady) return next();
  const p = String(req.path || "").toLowerCase();
  if (p === "/api/health") return next();
  if (p.startsWith("/api/")) {
    return res.status(503).json({
      ok: false, maintenance: true,
      message: MAINTENANCE_MODE ? MAINTENANCE_MESSAGE : "The system is reconnecting. Try again shortly.",
    });
  }
  if (p === "/maintenance.html" || p === "/style.css" || p.startsWith("/logos/")) return next();
  return res.sendFile(path.join(__dirname, "..", "public", "maintenance.html"));
});
app.use(express.static(path.join(__dirname, "..", "public"), {
  etag: false, lastModified: false,
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
}));

// ── health ───────────────────────────────────────────────
// Point the keep-alive cron job at THIS, not /api/me. It runs a real query,
// which keeps both the web service and the database awake. A managed Postgres
// on a free tier (Supabase, Neon) pauses after ~a week of no queries — and
// /api/me returns without touching the database when nobody is signed in.
app.get("/api/health", wrap(async (req, res) => {
  const t0 = Date.now();
  // maintenanceMode is reported unconditionally: the maintenance page's
  // front-end needs to tell "someone deliberately turned this off" apart
  // from "the database came back", because they call for different UI —
  // an explicit maintenance window can't be dismissed by a health check
  // recovering, only by MAINTENANCE_MODE actually being turned off.
  const base = { maintenanceMode: MAINTENANCE_MODE };
  try {
    await db.query("SELECT 1");
    // A live query just succeeded — if we were marked down (e.g. Supabase
    // had paused and this ping woke it), recognise that immediately instead
    // of waiting for the background retry timer. The cron job that's meant
    // to keep the database awake ends up being the same ping that notices
    // it's back.
    if (markDbUp()) console.log(" * database reachable again (via /api/health)");
    res.json({ ...base, ok: true, db: "up", ms: Date.now() - t0 });
  } catch (e) {
    markDbDown(db.friendlyConnectionError(e));
    res.status(503).json({ ...base, ok: false, db: "down", reason: dbError, downSince });
  }
}));

// ── auth routes ──────────────────────────────────────────
app.post("/api/login", wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const u = await auth.authenticate(email, password);
  if (!u) return res.status(401).json({ error: "wrong email or password" });
  auth.setSession(res, u);
  res.json({ ok: true, user: auth.publicUser(u) });
}));

app.post("/api/logout", (req, res) => { auth.clearSession(res); res.json({ ok: true }); });

app.get("/api/me", wrap(async (req, res) => {
  if (!req.user) return res.json({ authed: false });
  const all = await partners.listPartners();
  const visible = req.user.role === "partner"
    ? all.filter((p) => p.slug === req.user.partner)
    : all;

  const withLogos = [];
  for (const p of visible) {
    withLogos.push({ slug: p.slug, name: p.name, hasLogo: await logos.hasLogo(p.slug) });
  }
  const own = req.user.role === "partner" ? await partners.getPartner(req.user.partner) : null;

  res.json({
    authed: true, user: req.user, currency: CURRENCY,
    partners: withLogos,
    flags: own ? (own.flags || {}) : null,
  });
}));

app.post("/api/change-password", auth.requireAuth, wrap(async (req, res) => {
  const { current, next } = req.body || {};
  if (!next || String(next).length < 6) return res.status(400).json({ error: "new password too short (min 6)" });
  if (!(await auth.authenticate(req.user.email, current))) {
    return res.status(400).json({ error: "current password is wrong" });
  }
  await auth.setOwnPassword(req.user.id, next);
  res.json({ ok: true });
}));

// ── scoping helpers ──────────────────────────────────────
// Partners never see: supplier name, cost/capital, markup, profit, ONELIVE
// profit — only the columns their flags allow.
function effectiveFlags(user, partner) {
  if (user.role === "partner") {
    const f = (partner && partner.flags) || {};
    return { commission: !!f.commission, cost: !!f.cost, margin: !!f.margin, onelive: false, supplier: false };
  }
  return { commission: true, cost: true, margin: true, onelive: true, supplier: true }; // admin/owner
}
const commLabel = (v) => ({ GOLD: "Gold", JEWELRY: "Jewelry" }[String(v || "").toUpperCase()] || (v ? String(v) : "—"));

// Global row filters (beyond the date window): free-text search, commission
// type, exact client. Applied server-side so KPIs/charts/tables all agree.
function applyFilters(records, q, canSeeSupplier) {
  const text = String(q.q || "").trim().toLowerCase();
  const ct = String(q.commType || "").trim().toUpperCase();
  const client = String(q.client || "").trim();
  if (!text && !ct && !client) return records;
  return records.filter((r) => {
    if (client && r.client !== client) return false;
    if (ct && String(r.commissionType || "").toUpperCase() !== ct) return false;
    if (text) {
      const parts = [r.invoice, r.client, r.pjCode, r.itemCode, r.itemType];
      if (canSeeSupplier) parts.push(r.supplier);   // partners can't probe supplier names
      if (!parts.join(" ").toLowerCase().includes(text)) return false;
    }
    return true;
  });
}

/** Which partner is this viewer allowed to look at? */
async function resolvePartner(req) {
  if (req.user.role === "partner") return partners.getPartner(req.user.partner);
  const q = req.query.partner;
  const all = await partners.listPartners();
  return (q && all.find((p) => p.slug === q)) || all[0] || null;
}

// Remove fields the viewer isn't allowed to see, on a *copy*.
function scope(agg, flags, dimension) {
  const typeSource = dimension === "commission" ? agg.commTypes : agg.types;
  const kpi = { lines: agg.kpi.lines, invoices: agg.kpi.invoices, clients: agg.kpi.clients,
    amount: agg.kpi.amount, weight: agg.kpi.weight };
  if (flags.commission) kpi.commissionValue = agg.kpi.commissionValue;
  if (flags.cost) kpi.cost = agg.kpi.cost;
  if (flags.margin) kpi.margin = agg.kpi.margin;
  if (flags.onelive) kpi.onelive = agg.kpi.onelive;

  const clients = agg.clients.map((c) => {
    const o = { client: c.client, amount: c.amount, invoices: c.invoices };
    if (flags.commission) o.commissionValue = c.commissionValue;
    if (flags.cost) o.cost = c.cost;
    if (flags.margin) o.margin = c.margin;
    return o;
  });
  const types = typeSource.map((t) => {
    const o = { itemType: t.itemType, amount: t.amount, weight: t.weight, count: t.count };
    if (flags.commission) o.commissionValue = t.commissionValue;
    return o;
  });
  const months = agg.months.map((m) => {
    const o = { month: m.month, amount: m.amount };
    if (flags.commission) o.commissionValue = m.commissionValue;
    return o;
  });
  const rows = agg.rows.slice(0, 5000).map((r) => {
    const o = { date: r.date, invoice: r.invoice, client: r.client,
      itemType: r.itemType || "—", commissionType: commLabel(r.commissionType),
      weight: r.weight, amount: r.amount, pjCode: r.pjCode || "—", itemCode: r.itemCode || "—",
      sellerStatus: r.sellerStatus || "", source: r.source || "import" };
    if (flags.supplier) o.supplier = r.supplier;                       // admin/owner only
    if (flags.cost) { o.supplierPrice = r.supplierPrice; o.capitalPerGram = r.capitalPerGram; }
    if (flags.commission) { o.commissionRate = r.commission; o.commissionValue = r.commissionValue; }
    return o;
  });
  return { kpi, clients, types, months, rows, rowsTotal: agg.rows.length };
}

// ── report (all roles) ───────────────────────────────────
app.get("/api/report", auth.requireAuth, wrap(async (req, res) => {
  const partner = await resolvePartner(req);
  if (!partner) return res.json({ empty: true, reason: "no partner assigned" });
  const ds = await partners.loadDataset(partner.slug);
  const flags = effectiveFlags(req.user, partner);
  const filtered = applyFilters(ds.records, req.query, flags.supplier);
  const agg = aggregate(filtered, { from: req.query.from, to: req.query.to });
  const dimension = "commission";   // everyone breaks down by Gold/Jewelry

  // Totals over the FULL filtered set (the register shows at most 5000 rows).
  const totals = { count: agg.rows.length, weight: 0, amount: 0 };
  if (flags.cost) totals.supplierPrice = 0;
  if (flags.commission) totals.commissionValue = 0;
  for (const r of agg.rows) {
    totals.weight += r.weight; totals.amount += r.amount;
    if (flags.cost) totals.supplierPrice += r.supplierPrice || 0;
    if (flags.commission) totals.commissionValue += r.commissionValue || 0;
  }

  // Filter options come from the UNfiltered dataset, so choosing one filter
  // doesn't empty the others' choices.
  const clientSet = new Set(ds.records.map((r) => r.client).filter(Boolean));

  // Balance payable is an ALL-TIME figure (not filtered by the date window):
  // what we still owe this partner overall.
  const payout = flags.commission ? await payments.summary(partner.slug) : null;

  res.json({
    currency: CURRENCY, partner: { slug: partner.slug, name: partner.name },
    meta: ds.meta, flags, typeDimension: dimension,
    totals, payout,
    filterOptions: { clients: [...clientSet].sort(), commTypes: ["Gold", "Jewelry"] },
    ...scope(agg, flags, dimension),
  });
}));

// ── invoices ─────────────────────────────────────────────
function scopeItem(r, flags) {
  const o = { reserve: r.invoice, date: r.date, client: r.client,
    itemType: r.itemType || "—", commissionType: commLabel(r.commissionType),
    pjCode: r.pjCode || "—", itemCode: r.itemCode || "—", weight: r.weight, amount: r.amount,
    sellerStatus: r.sellerStatus || "" };
  if (flags.supplier) o.supplier = r.supplier;                        // admin/owner only
  if (flags.cost) { o.supplierPrice = r.supplierPrice; o.capitalPerGram = r.capitalPerGram; }
  if (flags.commission) { o.commissionRate = r.commission; o.commissionValue = r.commissionValue; }
  return o;
}
function scopeInvoice(inv, flags, hasProof) {
  const o = { reserve: inv.reserve, date: inv.date, clients: inv.clients, count: inv.count,
    amount: inv.amount, weight: inv.weight, hasProof, source: inv.source || "import" };
  if (flags.commission) o.commissionValue = inv.commissionValue;
  if (flags.cost) o.cost = inv.cost;
  if (flags.margin) o.margin = inv.margin;
  return o;
}

app.get("/api/invoices", auth.requireAuth, wrap(async (req, res) => {
  const partner = await resolvePartner(req);
  if (!partner) return res.json({ invoices: [] });
  const ds = await partners.loadDataset(partner.slug);
  const flags = effectiveFlags(req.user, partner);
  const pset = await proofs.proofSet(partner.slug);
  const filtered = applyFilters(ds.records, req.query, flags.supplier);
  const invoices = groupInvoices(filtered, { from: req.query.from, to: req.query.to })
    .map((inv) => scopeInvoice(inv, flags, pset.has(inv.reserve)));
  res.json({ partner: { slug: partner.slug, name: partner.name }, currency: CURRENCY, flags, invoices });
}));

app.get("/api/invoice", auth.requireAuth, wrap(async (req, res) => {
  const partner = await resolvePartner(req);
  if (!partner) return res.status(404).json({ error: "no partner" });
  const reserve = String(req.query.reserve || "");
  const ds = await partners.loadDataset(partner.slug);
  const flags = effectiveFlags(req.user, partner);
  const inv = groupInvoices(ds.records).find((i) => i.reserve === reserve);
  if (!inv) return res.status(404).json({ error: "invoice not found" });
  const proof = await proofs.getProof(partner.slug, reserve);
  res.json({
    currency: CURRENCY, partner: { slug: partner.slug, name: partner.name }, flags,
    reserve, date: inv.date, clients: inv.clients,
    totals: scopeInvoice(inv, flags, !!proof),
    items: inv.items.map((r) => scopeItem(r, flags)),
    proof: proof ? { url: `/api/invoice-proof?partner=${partner.slug}&reserve=${encodeURIComponent(reserve)}&t=${Date.now()}`, uploadedAt: proof.uploadedAt } : null,
    canUpload: req.user.role === "admin",
    source: inv.source || "import",
    canEdit: req.user.role === "admin" && (inv.source || "import") === "manual",
  });
}));

app.post("/api/invoice-proof", auth.requireRole("admin"), imageUpload.single("file"), wrap(async (req, res) => {
  const partner = await partners.getPartner((req.body && req.body.partner) || "");
  const reserve = req.body && req.body.reserve;
  if (!partner) return res.status(400).json({ error: "unknown partner" });
  if (!reserve) return res.status(400).json({ error: "reserve required" });
  if (!req.file) return res.status(400).json({ error: "no image uploaded" });
  try {
    const rec = await proofs.setProof(partner.slug, reserve, req.file.buffer, req.file.mimetype);
    res.json({ ok: true, uploadedAt: rec.uploadedAt });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));

app.get("/api/invoice-proof", auth.requireAuth, wrap(async (req, res) => {
  const slug = req.query.partner, reserve = req.query.reserve;
  if (req.user.role === "partner" && slug !== req.user.partner) return res.status(403).end();
  const proof = await proofs.getProof(slug, reserve);
  if (!proof) return res.status(404).end();
  res.setHeader("Content-Type", proof.mime);
  res.setHeader("Cache-Control", "private, max-age=60");
  res.end(proof.bytes);
}));

// ── owner portfolio (admin + owner) ──────────────────────
app.get("/api/portfolio", auth.requireRole("admin", "owner"), wrap(async (req, res) => {
  const { from, to } = req.query;
  const rows = [];
  const grand = { amount: 0, commissionValue: 0, cost: 0, margin: 0, onelive: 0, invoices: 0, lines: 0 };
  for (const p of await partners.listPartners()) {
    const ds = await partners.loadDataset(p.slug);
    const a = aggregate(ds.records, { from, to }).kpi;
    rows.push({ slug: p.slug, name: p.name, amount: a.amount, commissionValue: a.commissionValue,
      cost: a.cost, margin: a.margin, onelive: a.onelive, invoices: a.invoices, clients: a.clients,
      lines: a.lines, uploadedAt: ds.meta ? ds.meta.uploadedAt : null });
    for (const k of Object.keys(grand)) grand[k] += a[k] || 0;
  }
  rows.sort((x, y) => y.amount - x.amount);
  res.json({ currency: CURRENCY, partners: rows, grand });
}));

// ── upload (admin) ───────────────────────────────────────
app.post("/api/upload", auth.requireRole("admin"), upload.single("file"), wrap(async (req, res) => {
  const slug = (req.body && req.body.partner) || "";
  const partner = await partners.getPartner(slug);
  if (!partner) return res.status(400).json({ error: "unknown partner — create it first" });
  if (!req.file) return res.status(400).json({ error: "no file uploaded" });
  try {
    const parsed = parseWorkbookBuffer(req.file.buffer);
    if (!parsed.records.length) {
      return res.status(400).json({ error: parsed.meta.error || "no rows found", meta: parsed.meta });
    }
    parsed.meta.fileName = req.file.originalname;

    // Warn if the sheet contains invoice numbers that already exist as MANUAL
    // invoices — otherwise the same invoice would appear twice in the report.
    const manualNos = await invoices.manualInvoiceNumbers(partner.slug);
    const collisions = [...new Set(
      parsed.records.map((r) => r.invoice).filter((n) => n && manualNos.has(n)))];

    const saved = await partners.saveDataset(partner.slug, parsed, {
      fileName: req.file.originalname, uploadedBy: req.user.email,
      fileBytes: req.file.buffer, fileMime: req.file.mimetype,
    });
    await invoices.audit(null, {
      actor: req.user.email, action: "upload", partnerSlug: partner.slug,
      entity: req.file.originalname,
      details: { rows: saved.rows, collisions },
    });
    res.json({
      ok: true, partner: partner.slug, meta: parsed.meta, rows: saved.rows,
      // Parser warnings (unrecognised date column, unreadable dates) come
      // first: they affect every row, where a collision affects a handful.
      warnings: [
        ...(parsed.meta.warnings || []),
        ...(collisions.length ? [
          `${collisions.length} invoice number(s) in this file already exist as manually-created ` +
          `invoices and now appear twice: ${collisions.slice(0, 5).join(", ")}` +
          (collisions.length > 5 ? "…" : "") +
          ". Delete the manual copies, or remove them from the spreadsheet."
        ] : []),
      ],
    });
  } catch (e) {
    res.status(500).json({ error: "could not read file: " + e.message });
  }
}));

// ── partner logo ─────────────────────────────────────────
app.post("/api/partner-logo", auth.requireRole("admin"), imageUpload.single("file"), wrap(async (req, res) => {
  const partner = await partners.getPartner((req.body && req.body.partner) || "");
  if (!partner) return res.status(400).json({ error: "unknown partner" });
  if (!req.file) return res.status(400).json({ error: "no image uploaded" });
  try {
    const rec = await logos.setLogo(partner.slug, req.file.buffer, req.file.mimetype);
    res.json({ ok: true, uploadedAt: rec.uploadedAt });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));

app.get("/api/partner-logo", auth.requireAuth, wrap(async (req, res) => {
  const slug = String(req.query.partner || "");
  if (req.user.role === "partner" && slug !== req.user.partner) return res.status(403).end();
  const logo = await logos.getLogo(slug);
  if (!logo) return res.status(404).end();
  res.setHeader("Content-Type", logo.mime);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.end(logo.bytes);
}));

// ── partner management (admin write, owner read) ─────────
app.get("/api/partners", auth.requireRole("admin", "owner"), wrap(async (req, res) => {
  const list = [];
  for (const p of await partners.listPartners()) {
    const ds = await partners.loadDataset(p.slug);
    const dataset = ds.meta ? {
      fileName: ds.meta.fileName || null, rows: ds.meta.rows,
      uploadedAt: ds.meta.uploadedAt, path: `postgres · partner ${p.slug}`,
    } : null;
    list.push({ ...p, dataset });
  }
  res.json({ partners: list });
}));

app.post("/api/partners", auth.requireRole("admin"), wrap(async (req, res) => {
  try { res.json({ ok: true, partner: await partners.createPartner(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));

app.patch("/api/partners/:slug", auth.requireRole("admin"), wrap(async (req, res) => {
  try { res.json({ ok: true, partner: await partners.updatePartner(req.params.slug, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));

// Upload history — lets a bad upload be identified (and later rolled back).
app.get("/api/partners/:slug/datasets", auth.requireRole("admin", "owner"), wrap(async (req, res) => {
  res.json({ datasets: await partners.listDatasets(req.params.slug) });
}));

// ── manual invoices (admin) ──────────────────────────────
// Created in the app, shown to the partner alongside imported rows, and never
// touched by an Excel upload (they carry source = 'manual').
app.post("/api/manual-invoice", auth.requireRole("admin"), wrap(async (req, res) => {
  const { partner: slug, ...inv } = req.body || {};
  const partner = await partners.getPartner(slug || "");
  if (!partner) return res.status(400).json({ error: "unknown partner" });
  try {
    const out = await invoices.createInvoice(partner.slug, inv, req.user.email);
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));

app.get("/api/manual-invoice", auth.requireRole("admin"), wrap(async (req, res) => {
  const inv = await invoices.getManualInvoice(req.query.partner, req.query.invoice);
  if (!inv) return res.status(404).json({ error: "manual invoice not found" });
  res.json(inv);
}));

app.put("/api/manual-invoice", auth.requireRole("admin"), wrap(async (req, res) => {
  const { partner: slug, originalInvoice, ...inv } = req.body || {};
  const partner = await partners.getPartner(slug || "");
  if (!partner) return res.status(400).json({ error: "unknown partner" });
  try {
    const out = await invoices.updateInvoice(partner.slug, originalInvoice, inv, req.user.email);
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));

app.delete("/api/manual-invoice", auth.requireRole("admin"), wrap(async (req, res) => {
  try {
    const out = await invoices.deleteInvoice(req.query.partner, req.query.invoice, req.user.email);
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));

// ── uploaded source files (admin + owner only) ───────────
// Partners must NEVER get this: the raw sheet contains supplier and cost
// columns that the whole scoping layer exists to hide.
app.get("/api/dataset-file", auth.requireRole("admin", "owner"), wrap(async (req, res) => {
  const row = await db.one(
    "SELECT file_name, file_mime, file_bytes FROM datasets WHERE id = $1", [req.query.id]);
  if (!row || !row.file_bytes) return res.status(404).json({ error: "file not stored for this upload" });
  res.setHeader("Content-Type", row.file_mime ||
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",
    `attachment; filename="${(row.file_name || "upload.xlsx").replace(/"/g, "")}"`);
  res.end(row.file_bytes);
}));

// ── audit trail (admin + owner) ──────────────────────────
app.get("/api/audit", auth.requireRole("admin", "owner"), wrap(async (req, res) => {
  res.json({ entries: await invoices.listAudit(req.query.partner || null, 200) });
}));

// ── commission payouts ───────────────────────────────────────────────
// A running account per partner: earned − paid = balance payable.
// Owner and admin record payments; the partner sees the statement read-only.

app.get("/api/payments", auth.requireAuth, wrap(async (req, res) => {
  const partner = await resolvePartner(req);
  if (!partner) return res.json({ payments: [], summary: null });
  const flags = effectiveFlags(req.user, partner);
  // If a partner isn't allowed to see commission at all, they can't see the
  // payout statement either — it's the same number.
  if (!flags.commission) return res.status(403).json({ error: "not available" });

  res.json({
    partner: { slug: partner.slug, name: partner.name },
    currency: CURRENCY,
    summary: await payments.summary(partner.slug),
    payments: await payments.listPayments(partner.slug),
    canRecord: req.user.role === "admin" || req.user.role === "owner",
  });
}));

app.post("/api/payments", auth.requireRole("admin", "owner"),
  imageUpload.single("file"), wrap(async (req, res) => {
    const partner = await partners.getPartner((req.body && req.body.partner) || "");
    if (!partner) return res.status(400).json({ error: "unknown partner" });
    try {
      const proof = req.file ? { mime: req.file.mimetype, bytes: req.file.buffer } : null;
      const out = await payments.addPayment(partner.slug, {
        amount: req.body.amount, paidOn: req.body.paidOn, method: req.body.method,
        reference: req.body.reference, note: req.body.note,
      }, req.user.email, proof);
      res.json({ ok: true, ...out });
    } catch (e) { res.status(400).json({ error: e.message }); }
  }));

app.delete("/api/payments/:id", auth.requireRole("admin", "owner"), wrap(async (req, res) => {
  try { res.json({ ok: true, ...(await payments.deletePayment(req.params.id, req.user.email)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));

// Proof of payment. Partners may only fetch their own.
app.get("/api/payment-proof", auth.requireAuth, wrap(async (req, res) => {
  const proof = await payments.getProof(req.query.id);
  if (!proof) return res.status(404).end();
  if (req.user.role === "partner" && proof.partnerSlug !== req.user.partner) {
    return res.status(403).end();
  }
  res.setHeader("Content-Type", proof.mime || "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=60");
  res.end(proof.bytes);
}));

/* ── user management ──────────────────────────────────────
 * Admins manage PARTNER accounts. Only the superadmin (pinned to
 * SUPERADMIN_EMAIL in the environment) may touch admin and owner accounts,
 * so no admin can lock another one — or the superadmin — out of the system.
 *
 * Every change is written to the audit log: these are the accounts that can
 * move money, so "who granted this access" must always have an answer.
 */
async function logUserChange(actor, action, target, details) {
  await db.query(
    `INSERT INTO audit_log (actor, action, partner_slug, entity, details)
     VALUES ($1,$2,$3,$4,$5)`,
    [actor.email, action, target.partner || null, target.email,
     JSON.stringify(details || {})]);
}

app.get("/api/users", auth.requireRole("admin"), wrap(async (req, res) => {
  // Archived accounts are hidden unless explicitly asked for — they are kept
  // forever so the audit trail keeps naming a person the system knows.
  const includeArchived = req.query.archived === "1";
  res.json({
    users: await auth.listUsers({ includeArchived }),
    canManagePrivileged: !!req.user.superadmin,
  });
}));

app.post("/api/users", auth.requireRole("admin"), wrap(async (req, res) => {
  const body = req.body || {};
  const denied = auth.canAssignRole(req.user, body.role);
  if (denied) return res.status(403).json({ error: denied });
  try {
    const user = await auth.createUser(body);
    await logUserChange(req.user, "user.create", user, { role: user.role, partner: user.partner });
    res.json({ ok: true, user });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));

app.patch("/api/users/:id", auth.requireRole("admin"), wrap(async (req, res) => {
  const patch = req.body || {};
  const existing = auth.publicUser(await auth.findById(req.params.id));
  if (!existing) return res.status(404).json({ error: "user not found" });

  // Guards live in auth.js so the rules can't drift between routes.
  const denied = auth.canManage(req.user, existing) ||
                 auth.canLockOut(req.user, existing, patch) ||
                 (patch.role != null ? auth.canAssignRole(req.user, patch.role) : null);
  if (denied) return res.status(403).json({ error: denied });

  try {
    const user = await auth.updateUser(req.params.id, { ...patch, actor: req.user.email });
    const action = patch.archived === true ? "user.archive"
                 : patch.archived === false ? "user.restore"
                 : patch.password ? "user.password_reset"
                 : patch.disabled != null ? (patch.disabled ? "user.disable" : "user.enable")
                 : "user.update";
    await logUserChange(req.user, action, user,
      { role: user.role, disabled: user.disabled, archived: !!user.archivedAt });
    res.json({ ok: true, user });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));

/* How much history an account has left behind. The UI shows this in the
   delete confirmation so nobody removes an account blind. */
app.get("/api/users/:id/activity", auth.requireSuperadmin, wrap(async (req, res) => {
  const u = auth.publicUser(await auth.findById(req.params.id));
  if (!u) return res.status(404).json({ error: "user not found" });
  res.json({ ok: true, email: u.email, activity: await auth.activityFor(u.email) });
}));

/* Hard delete — superadmin only.
 *
 * Archiving is the normal way to remove somebody, and it is what the audit
 * trail wants: `audit_log.actor` and `records.created_by` store an email as
 * free text, so deleting the row leaves those entries naming a person the
 * system no longer knows. This exists for the cases where that doesn't
 * matter — a typo'd address, a duplicate, a test account.
 *
 * Two safeguards: the caller must pass the exact email as `?confirm=`, so a
 * mis-aimed request cannot delete the wrong person; and the audit entry is
 * written BEFORE the row goes, recording who this was and what they had
 * touched, so the trail still explains the gap afterwards.
 */
app.delete("/api/users/:id", auth.requireSuperadmin, wrap(async (req, res) => {
  const target = auth.publicUser(await auth.findById(req.params.id));
  if (!target) return res.status(404).json({ error: "user not found" });

  const denied = auth.canDelete(req.user, target);
  if (denied) return res.status(403).json({ error: denied });

  const confirm = String(req.query.confirm || "").trim().toLowerCase();
  if (confirm !== String(target.email).toLowerCase()) {
    return res.status(400).json({
      error: "confirmation required: pass ?confirm=<the account's exact email>",
    });
  }

  const activity = await auth.activityFor(target.email);
  await logUserChange(req.user, "user.delete", target, {
    name: target.name, role: target.role, partner: target.partner,
    archivedAt: target.archivedAt, activityAtDeletion: activity,
    note: "row permanently removed; this entry is the remaining record of the account",
  });
  await auth.deleteUser(target.id);
  res.json({ ok: true, deleted: target.email, activity });
}));

// ── error handler (must be last) ─────────────────────────
app.use((err, req, res, next) => {
  console.error(" ! request failed:", err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "server error: " + err.message });
});

// ── startup ──────────────────────────────────────────────
const CANDIDATE_PORTS = [PORT, 5056, 5065, 5155, 3055, 0];

function listenOn(i) {
  if (i >= CANDIDATE_PORTS.length) { console.error("\n ! Could not bind any port.\n"); process.exit(1); }
  const p = CANDIDATE_PORTS[i];
  const server = app.listen(p, () => {
    const actual = server.address().port;
    console.log(`\n * Perfect Jewel accounting on http://localhost:${actual}`);
    console.log(" * connecting to the database...");
    if (actual !== PORT) console.log(`\n   (port ${PORT} was busy — using ${actual}; open the URL above)`);
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.log(` * port ${p} busy, trying another…`);
      listenOn(i + 1);
    } else { throw e; }
  });
}

/*
 * Connect to the database, apply the schema, seed the first accounts.
 *
 * IMPORTANT — this used to run BEFORE the port was opened. If the database
 * was unreachable (bad DATABASE_URL, Supabase paused, wrong password), the
 * process threw and exited without ever binding a port. On Render that looks
 * like a deploy that never finishes: Render's health check never sees an
 * open port, assumes the boot is still in progress, and keeps restarting the
 * container — the endless "Application loading" screen. Maintenance mode
 * couldn't help either, because the app that would serve the maintenance
 * page never started.
 *
 * Now: the port opens FIRST (see start()), and this function is called
 * afterwards. If it fails, it flips `dbReady` to false — which puts the site
 * into maintenance mode automatically — and retries itself with backoff
 * instead of giving up. A transient problem (Supabase waking up, a brief
 * network blip) heals on its own with no redeploy; a real misconfiguration
 * shows the maintenance page instead of Render's spinner or a raw crash,
 * and the actual reason is always in the log and at /api/health.
 */
let retryDelayMs = 5000;
const MAX_RETRY_DELAY_MS = 60000;

async function connectDb() {
  try {
    db.assertUsableConnectionString();
    await db.init();
    await auth.initSecret();
    await auth.seedIfEmpty("jeffmathewg@gmail.com");
    const list = (await partners.listPartners()).map((x) => x.slug);

    const wasDown = markDbUp();
    retryDelayMs = 5000;    // reset backoff for next time
    console.log(`\n * database ready — partners: ${list.join(", ") || "none"}`);
    if (wasDown) console.log(" * (was previously unreachable — site is live again)");
  } catch (e) {
    const msg = (e && e.message) || (e && e.code) || String(e) || "unknown error";
    markDbDown(msg);
    console.error("\n ! Database not ready — serving the maintenance page instead of crashing.");
    console.error("   " + msg);
    console.error(`   Retrying in ${Math.round(retryDelayMs / 1000)}s...\n`);
    setTimeout(connectDb, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
  }
}

/** Open the port immediately, then connect to the database in the background. */
async function start() {
  listenOn(0);
  connectDb();   // deliberately not awaited — the server must be listening either way
}

if (require.main === module) start();

module.exports = { app, start };
