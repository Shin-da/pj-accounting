/*
 * Excel -> normalized records -> aggregates.
 *
 * The real RDR workbook has several sheets: two master registers (JULY,
 * AUGUST) plus one tab per client that repeats the same rows. We ingest only
 * the master sheet(s) (see MASTER_SHEET_RE) so nothing is double-counted, and
 * map headers loosely because the layout is still being finalised.
 */
const XLSX = require("xlsx");
const { COLUMN_ALIASES, MASTER_SHEET_RE } = require("../config");

const norm = (s) => String(s ?? "").toUpperCase().replace(/\s+/g, " ").trim();

function num(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}

function toISO(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null;
    if (d && d.y) return `${d.y}-${String(d.m).padStart(2,"0")}-${String(d.d).padStart(2,"0")}`;
  }
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function mapHeaders(headerRow) {
  const cells = headerRow.map(norm);
  const map = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const a of aliases) {
      const idx = cells.indexOf(norm(a));
      if (idx >= 0) { map[field] = idx; break; }
    }
  }
  return map;
}

// Parse one sheet's array-of-arrays into records. Returns null if no usable
// header row is found (empty tab, or one without client + amount columns).
function parseSheet(aoa, sheetName) {
  let headerIdx = -1, map = {};
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const m = mapHeaders(aoa[i]);
    if (m.client != null && (m.amount != null || m.commissionValue != null)) {
      headerIdx = i; map = m; break;
    }
  }
  if (headerIdx < 0) return null;

  const records = [];
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const r = aoa[i];
    const get = (f) => (map[f] != null ? r[map[f]] : "");
    const client = String(get("client") ?? "").trim();
    if (!client || /^total/i.test(client)) continue;   // skip blanks & TOTAL rows
    const amount = num(get("amount"));
    // Commission money: prefer the dedicated amount column when present;
    // otherwise fall back to a numeric value in the "RDR COMMISSION" column.
    const commissionValue = map.commissionValue != null
      ? num(get("commissionValue")) : num(get("commission"));
    const blank = (v) => { const s = String(v ?? "").trim(); return s === "-" ? "" : s; };
    const supplier = blank(get("supplier"));
    const itemType = blank(get("itemType"));
    records.push({
      date: toISO(get("date")),
      invoice: String(get("invoice") ?? "").trim(),
      client,
      pjCode: String(get("pjCode") ?? "").trim(),
      itemCode: String(get("itemCode") ?? "").trim(),
      itemType: itemType || supplier || "Unspecified",   // fall back to supplier
      supplier: supplier || "—",
      weight: num(get("weight")),
      capitalPerGram: num(get("capitalPerGram")),
      supplierPrice: num(get("supplierPrice")),
      amount,
      onelive: num(get("onelive")),
      commission: String(get("commission") ?? "").trim(),
      commissionType: String(get("commissionType") ?? "").trim(),
      commissionValue,
      sheet: sheetName,
    });
  }
  return { records, columns: Object.keys(map) };
}

function parseWorkbookBuffer(buf) {
  const wb = XLSX.read(buf, { cellDates: true });
  const parsedByName = {};
  for (const sn of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, blankrows: false, defval: "" });
    const p = parseSheet(aoa, sn);
    if (p && p.records.length) parsedByName[sn] = p;
  }

  const names = Object.keys(parsedByName);
  if (!names.length) {
    return { records: [], meta: { error: "No sheet had the expected columns (need at least CLIENT NAME + a sale amount).", sheets: wb.SheetNames } };
  }

  // Prefer master register sheets; otherwise fall back to the first data sheet.
  const masters = names.filter((n) => MASTER_SHEET_RE.test(n));
  const used = masters.length ? masters : [names[0]];

  let records = [], columns = new Set();
  for (const n of used) {
    records = records.concat(parsedByName[n].records);
    parsedByName[n].columns.forEach((c) => columns.add(c));
  }

  const dates = records.map((r) => r.date).filter(Boolean).sort();
  return {
    records,
    meta: {
      rows: records.length,
      sheetsUsed: used,
      sheetsAvailable: wb.SheetNames.filter((s) => s),
      columns: [...columns],
      missing: Object.keys(COLUMN_ALIASES).filter((k) => !columns.has(k)),
      minDate: dates[0] || null,
      maxDate: dates[dates.length - 1] || null,
      uploadedAt: new Date().toISOString(),
    },
  };
}

// Sum + group, filtered to an optional [from,to] date window.
function aggregate(records, { from, to } = {}) {
  const rows = records.filter((r) => {
    if (from && (!r.date || r.date < from)) return false;
    if (to && (!r.date || r.date > to)) return false;
    return true;
  });

  const kpi = {
    lines: rows.length,
    invoices: new Set(rows.map((r) => r.invoice).filter(Boolean)).size,
    clients: new Set(rows.map((r) => r.client).filter(Boolean)).size,
    amount: 0, commissionValue: 0, weight: 0, cost: 0, onelive: 0,
  };
  const byClient = new Map(), byType = new Map(), byMonth = new Map(), byCommType = new Map();
  const commLabel = (v) => ({ GOLD: "Gold", JEWELRY: "Jewelry" }[String(v || "").toUpperCase()] || (v ? String(v) : "Other"));

  for (const r of rows) {
    const cost = r.supplierPrice || (r.weight * r.capitalPerGram);
    kpi.amount += r.amount;
    kpi.commissionValue += r.commissionValue;
    kpi.weight += r.weight;
    kpi.cost += cost;
    kpi.onelive += r.onelive;

    const c = byClient.get(r.client) || { client: r.client, amount: 0, commissionValue: 0, cost: 0, invoices: new Set() };
    c.amount += r.amount; c.commissionValue += r.commissionValue; c.cost += cost;
    if (r.invoice) c.invoices.add(r.invoice);
    byClient.set(r.client, c);

    const t = byType.get(r.itemType) || { itemType: r.itemType, amount: 0, commissionValue: 0, weight: 0, count: 0 };
    t.amount += r.amount; t.commissionValue += r.commissionValue; t.weight += r.weight; t.count += 1;
    byType.set(r.itemType, t);

    // Group by commission type (Gold / Jewelry) — used for the partner view.
    const ckey = commLabel(r.commissionType);
    const ct = byCommType.get(ckey) || { itemType: ckey, amount: 0, commissionValue: 0, weight: 0, count: 0 };
    ct.amount += r.amount; ct.commissionValue += r.commissionValue; ct.weight += r.weight; ct.count += 1;
    byCommType.set(ckey, ct);

    const mk = (r.date || "").slice(0, 7) || "—";
    const m = byMonth.get(mk) || { month: mk, amount: 0, commissionValue: 0 };
    m.amount += r.amount; m.commissionValue += r.commissionValue;
    byMonth.set(mk, m);
  }
  kpi.margin = kpi.amount - kpi.cost;

  const clients = [...byClient.values()]
    .map((c) => ({ ...c, invoices: c.invoices.size, margin: c.amount - c.cost }))
    .sort((a, b) => b.amount - a.amount);
  const types = [...byType.values()].sort((a, b) => b.amount - a.amount);
  const commTypes = [...byCommType.values()].sort((a, b) => b.amount - a.amount);
  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));

  return { kpi, clients, types, commTypes, months, rows };
}

module.exports = { parseWorkbookBuffer, aggregate };
