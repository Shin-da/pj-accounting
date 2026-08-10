/*
 * RDR report server — now multi-user.
 *
 * Roles: admin (upload + manage users/partners + see all), owner (read-only
 * portfolio across all partners incl. PJ profit), partner (own report only,
 * filtered by that partner's visibility flags).
 *
 * Data is scoped SERVER-SIDE: a partner can never pull another partner's data
 * or a hidden field, no matter what the client asks for.
 */
const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");

const { PORT, CURRENCY, COLUMN_ALIASES } = require("../config");
const { parseWorkbookBuffer, aggregate, groupInvoices } = require("./parse");
const auth = require("./auth");
const partners = require("./partners");
const proofs = require("./proofs");
const logos = require("./logos");

// Relative, repo-rooted path shown to admins so they know where an upload landed.
function datasetDisplayPath(slug) { return `data/datasets/${slug}.json`; }

// Boot-time setup: seed the first admin, migrate any existing dataset to RDR.
auth.seedIfEmpty("jeffmathewg@gmail.com");
partners.migrateIfNeeded();

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(auth.attachUser);
app.use(express.static(path.join(__dirname, "..", "public"), {
  etag: false, lastModified: false,
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
}));

// ── auth routes ──────────────────────────────────────────
app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  const u = auth.authenticate(email, password);
  if (!u) return res.status(401).json({ error: "wrong email or password" });
  auth.setSession(res, u);
  res.json({ ok: true, user: auth.publicUser(u) });
});
app.post("/api/logout", (req, res) => { auth.clearSession(res); res.json({ ok: true }); });

app.get("/api/me", (req, res) => {
  if (!req.user) return res.json({ authed: false });
  const all = partners.listPartners();
  const visible = req.user.role === "partner"
    ? all.filter((p) => p.slug === req.user.partner)
    : all;
  res.json({
    authed: true, user: req.user, currency: CURRENCY,
    partners: visible.map((p) => ({ slug: p.slug, name: p.name, hasLogo: logos.hasLogo(p.slug) })),
    flags: req.user.role === "partner" ? (partners.getPartner(req.user.partner)?.flags || {}) : null,
  });
});

app.post("/api/change-password", auth.requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  if (!next || String(next).length < 6) return res.status(400).json({ error: "new password too short (min 6)" });
  if (!auth.authenticate(req.user.email, current)) return res.status(400).json({ error: "current password is wrong" });
  auth.setOwnPassword(req.user.id, next);
  res.json({ ok: true });
});

// ── scoping helpers ──────────────────────────────────────
// Partners never see: supplier name, cost/capital, markup, profit, ONELIVE
// profit, or the raw commission rate — only the highlighted columns.
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

// Which partner is this viewer allowed to look at?
function resolvePartner(req) {
  if (req.user.role === "partner") return partners.getPartner(req.user.partner);
  const q = req.query.partner;
  const all = partners.listPartners();
  return (q && all.find((p) => p.slug === q)) || all[0] || null;
}

// Remove fields the viewer isn't allowed to see, on a *copy*.
// `dimension` chooses the breakdown: "item" (supplier/item type) for admin &
// owner, "commission" (Gold / Jewelry) for partners.
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
      weight: r.weight, amount: r.amount, pjCode: r.pjCode || "—", itemCode: r.itemCode || "—" };
    if (flags.supplier) o.supplier = r.supplier;                       // admin/owner only
    if (flags.cost) { o.supplierPrice = r.supplierPrice; o.capitalPerGram = r.capitalPerGram; }
    if (flags.commission) { o.commissionRate = r.commission; o.commissionValue = r.commissionValue; }
    return o;
  });
  return { kpi, clients, types, months, rows, rowsTotal: agg.rows.length };
}

// ── report (all roles) ───────────────────────────────────
app.get("/api/report", auth.requireAuth, (req, res) => {
  const partner = resolvePartner(req);
  if (!partner) return res.json({ empty: true, reason: "no partner assigned" });
  const ds = partners.loadDataset(partner.slug);
  const flags = effectiveFlags(req.user, partner);
  const filtered = applyFilters(ds.records, req.query, flags.supplier);
  const agg = aggregate(filtered, { from: req.query.from, to: req.query.to });
  // Everyone breaks down by commission type (Gold/Jewelry), not raw item/SKU type.
  const dimension = "commission";

  // Totals over the FULL filtered set (register shows at most 5000 rows).
  const totals = { count: agg.rows.length, weight: 0, amount: 0 };
  if (flags.cost) totals.supplierPrice = 0;
  if (flags.commission) totals.commissionValue = 0;
  for (const r of agg.rows) {
    totals.weight += r.weight; totals.amount += r.amount;
    if (flags.cost) totals.supplierPrice += r.supplierPrice || 0;
    if (flags.commission) totals.commissionValue += r.commissionValue || 0;
  }

  // Options for the filter dropdowns come from the UNfiltered dataset, so
  // choosing one filter doesn't empty the others' choices.
  const clientSet = new Set(ds.records.map((r) => r.client).filter(Boolean));

  res.json({
    currency: CURRENCY, partner: { slug: partner.slug, name: partner.name },
    meta: ds.meta, flags, typeDimension: dimension,
    totals,
    filterOptions: { clients: [...clientSet].sort(), commTypes: ["Gold", "Jewelry"] },
    ...scope(agg, flags, dimension),
  });
});

// ── invoices ─────────────────────────────────────────────
// Field-scoped copies for a partner's visibility flags.
function scopeItem(r, flags) {
  const o = { reserve: r.invoice, date: r.date, client: r.client,
    itemType: r.itemType || "—", commissionType: commLabel(r.commissionType),
    pjCode: r.pjCode || "—", itemCode: r.itemCode || "—", weight: r.weight, amount: r.amount };
  if (flags.supplier) o.supplier = r.supplier;                        // admin/owner only
  if (flags.cost) { o.supplierPrice = r.supplierPrice; o.capitalPerGram = r.capitalPerGram; }
  if (flags.commission) { o.commissionRate = r.commission; o.commissionValue = r.commissionValue; }
  return o;
}
function scopeInvoice(inv, flags, hasProof) {
  const o = { reserve: inv.reserve, date: inv.date, clients: inv.clients, count: inv.count,
    amount: inv.amount, weight: inv.weight, hasProof };
  if (flags.commission) o.commissionValue = inv.commissionValue;
  if (flags.cost) o.cost = inv.cost;
  if (flags.margin) o.margin = inv.margin;
  return o;
}

// List of invoices (scoped) for the current viewer's partner.
app.get("/api/invoices", auth.requireAuth, (req, res) => {
  const partner = resolvePartner(req);
  if (!partner) return res.json({ invoices: [] });
  const ds = partners.loadDataset(partner.slug);
  const flags = effectiveFlags(req.user, partner);
  const pset = proofs.proofSet(partner.slug);
  const filtered = applyFilters(ds.records, req.query, flags.supplier);
  const invoices = groupInvoices(filtered, { from: req.query.from, to: req.query.to })
    .map((inv) => scopeInvoice(inv, flags, pset.has(inv.reserve)));
  res.json({ partner: { slug: partner.slug, name: partner.name }, currency: CURRENCY, flags, invoices });
});

// One invoice's detail (line items + totals + proof), scoped.
app.get("/api/invoice", auth.requireAuth, (req, res) => {
  const partner = resolvePartner(req);
  if (!partner) return res.status(404).json({ error: "no partner" });
  const reserve = String(req.query.reserve || "");
  const ds = partners.loadDataset(partner.slug);
  const flags = effectiveFlags(req.user, partner);
  const inv = groupInvoices(ds.records).find((i) => i.reserve === reserve);
  if (!inv) return res.status(404).json({ error: "invoice not found" });
  const proof = proofs.getProof(partner.slug, reserve);
  res.json({
    currency: CURRENCY, partner: { slug: partner.slug, name: partner.name }, flags,
    reserve, date: inv.date, clients: inv.clients,
    totals: scopeInvoice(inv, flags, !!proof),
    items: inv.items.map((r) => scopeItem(r, flags)),
    proof: proof ? { url: `/api/invoice-proof?partner=${partner.slug}&reserve=${encodeURIComponent(reserve)}&t=${Date.now()}`, uploadedAt: proof.uploadedAt } : null,
    canUpload: req.user.role === "admin",
  });
});

// Admin uploads a proof image for one invoice.
app.post("/api/invoice-proof", auth.requireRole("admin"), imageUpload.single("file"), (req, res) => {
  const partner = partners.getPartner((req.body && req.body.partner) || "");
  const reserve = req.body && req.body.reserve;
  if (!partner) return res.status(400).json({ error: "unknown partner" });
  if (!reserve) return res.status(400).json({ error: "reserve required" });
  if (!req.file) return res.status(400).json({ error: "no image uploaded" });
  try {
    const rec = proofs.setProof(partner.slug, reserve, req.file.buffer, req.file.mimetype);
    res.json({ ok: true, uploadedAt: rec.uploadedAt });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Serve a proof image (auth; partners only their own).
app.get("/api/invoice-proof", auth.requireAuth, (req, res) => {
  const slug = req.query.partner, reserve = req.query.reserve;
  if (req.user.role === "partner" && slug !== req.user.partner) return res.status(403).end();
  const proof = proofs.getProof(slug, reserve);
  if (!proof) return res.status(404).end();
  res.setHeader("Content-Type", proof.mime);
  res.setHeader("Cache-Control", "private, max-age=60");
  fs.createReadStream(proof.abs).pipe(res);
});

// ── owner portfolio (admin + owner) ──────────────────────
app.get("/api/portfolio", auth.requireRole("admin", "owner"), (req, res) => {
  const { from, to } = req.query;
  const rows = [];
  const grand = { amount: 0, commissionValue: 0, cost: 0, margin: 0, onelive: 0, invoices: 0, lines: 0 };
  for (const p of partners.listPartners()) {
    const ds = partners.loadDataset(p.slug);
    const a = aggregate(ds.records, { from, to }).kpi;
    rows.push({ slug: p.slug, name: p.name, amount: a.amount, commissionValue: a.commissionValue,
      cost: a.cost, margin: a.margin, onelive: a.onelive, invoices: a.invoices, clients: a.clients,
      lines: a.lines, uploadedAt: ds.meta ? ds.meta.uploadedAt : null });
    for (const k of Object.keys(grand)) grand[k] += a[k] || 0;
  }
  rows.sort((x, y) => y.amount - x.amount);
  res.json({ currency: CURRENCY, partners: rows, grand });
});

// ── upload (admin) ───────────────────────────────────────
app.post("/api/upload", auth.requireRole("admin"), upload.single("file"), (req, res) => {
  const slug = (req.body && req.body.partner) || "";
  const partner = partners.getPartner(slug);
  if (!partner) return res.status(400).json({ error: "unknown partner — create it first" });
  if (!req.file) return res.status(400).json({ error: "no file uploaded" });
  try {
    const parsed = parseWorkbookBuffer(req.file.buffer);
    if (!parsed.records.length) return res.status(400).json({ error: parsed.meta.error || "no rows found", meta: parsed.meta });
    parsed.meta.fileName = req.file.originalname;
    partners.saveDataset(partner.slug, parsed);
    res.json({ ok: true, partner: partner.slug, meta: parsed.meta, path: datasetDisplayPath(partner.slug) });
  } catch (e) {
    res.status(500).json({ error: "could not read file: " + e.message });
  }
});

// ── partner logo ─────────────────────────────────────────
// Admin uploads; anyone signed in may view (partners only their own).
app.post("/api/partner-logo", auth.requireRole("admin"), imageUpload.single("file"), (req, res) => {
  const partner = partners.getPartner((req.body && req.body.partner) || "");
  if (!partner) return res.status(400).json({ error: "unknown partner" });
  if (!req.file) return res.status(400).json({ error: "no image uploaded" });
  try {
    const rec = logos.setLogo(partner.slug, req.file.buffer, req.file.mimetype);
    res.json({ ok: true, uploadedAt: rec.uploadedAt });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/partner-logo", auth.requireAuth, (req, res) => {
  const slug = String(req.query.partner || "");
  if (req.user.role === "partner" && slug !== req.user.partner) return res.status(403).end();
  const logo = logos.getLogo(slug);
  if (!logo) return res.status(404).end();
  res.setHeader("Content-Type", logo.mime);
  res.setHeader("Cache-Control", "private, max-age=300");
  fs.createReadStream(logo.abs).pipe(res);
});

// ── partner management (admin write, owner read) ─────────
app.get("/api/partners", auth.requireRole("admin", "owner"), (req, res) => {
  const list = partners.listPartners().map((p) => {
    const ds = partners.loadDataset(p.slug);
    const dataset = ds.meta ? {
      fileName: ds.meta.fileName || null, rows: ds.meta.rows,
      uploadedAt: ds.meta.uploadedAt, path: datasetDisplayPath(p.slug),
    } : null;
    return { ...p, dataset };
  });
  res.json({ partners: list });
});
app.post("/api/partners", auth.requireRole("admin"), (req, res) => {
  try { res.json({ ok: true, partner: partners.createPartner(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch("/api/partners/:slug", auth.requireRole("admin"), (req, res) => {
  try { res.json({ ok: true, partner: partners.updatePartner(req.params.slug, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── user management (admin) ──────────────────────────────
app.get("/api/users", auth.requireRole("admin"), (req, res) => res.json({ users: auth.listUsers() }));
app.post("/api/users", auth.requireRole("admin"), (req, res) => {
  try { res.json({ ok: true, user: auth.createUser(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch("/api/users/:id", auth.requireRole("admin"), (req, res) => {
  try { res.json({ ok: true, user: auth.updateUser(req.params.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Try the preferred port, then a few fallbacks, so a leftover copy on 5055
// doesn't hard-crash the app — it just uses the next free port and says so.
const CANDIDATE_PORTS = [PORT, 5056, 5065, 5155, 3055, 0];
function listenOn(i) {
  if (i >= CANDIDATE_PORTS.length) { console.error("\n ! Could not bind any port.\n"); process.exit(1); }
  const p = CANDIDATE_PORTS[i];
  const server = app.listen(p, () => {
    const actual = server.address().port;
    console.log(`\n * RDR report on http://localhost:${actual}`);
    console.log(` * partners: ${partners.listPartners().map((x) => x.slug).join(", ") || "none"}`);
    if (actual !== PORT) console.log(`\n   (port ${PORT} was busy — using ${actual}; open the URL above)`);
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.log(` * port ${p} busy, trying another…`);
      listenOn(i + 1);
    } else { throw e; }
  });
}
listenOn(0);
