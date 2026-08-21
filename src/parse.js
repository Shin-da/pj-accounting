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

const norm = (s) => String(s ?? "").toUpperCase().replace(/\./g, "").replace(/\s+/g, " ").trim();

// When a header appears more than once (e.g. two "RDR COMMISSION AMOUNT"
// columns), take the LAST one for these fields — that's the highlighted /
// selling-based commission the partner should see.
const PREFER_LAST = new Set(["commissionValue"]);

function num(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}

const p2 = (n) => String(n).padStart(2, "0");
// A calendar date, formatted from LOCAL parts. toISOString() must never be
// used here: an Excel date is a calendar date, not an instant, and converting
// it to UTC shifts every row back a day on any machine east of Greenwich
// (e.g. Asia/Manila, Asia/Shanghai).
const ymd = (y, m, d) => `${y}-${p2(m)}-${p2(d)}`;

/*
 * Excel cell -> "YYYY-MM-DD", or null when there is no usable date.
 *
 * The date column is NOT always a real date cell. When the column is
 * formatted as text (or the value was typed with a leading apostrophe) we get
 * a string like "30/07/2026" — and `new Date("30/07/2026")` is Invalid Date,
 * because JS reads slash-separated dates as MM/DD/YYYY. That silently nulled
 * every row past the 12th of the month and mis-read the rest (04/07 -> Apr 7).
 * So day-first strings are parsed explicitly, matching the sheet's own
 * "INVOICE DATE (DD/MM/YYYY)" header.
 */
function toISO(v, dayFirst = true) {
  if (v == null || v === "") return null;

  if (v instanceof Date) return isNaN(v) ? null : ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());

  // Excel serial number (sheet read without cellDates, or a stray numeric cell).
  if (typeof v === "number") {
    if (!isFinite(v) || v <= 0) return null;
    const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null;
    return d && d.y ? ymd(d.y, d.m, d.d) : null;
  }

  const s = String(v).trim();
  if (!s || s === "-" || /^(n\/?a|none|tbd)$/i.test(s)) return null;

  // ISO-ish: 2026-07-30 / 2026.07.30
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return ymd(m[1], +m[2], +m[3]);

  // Day-first: 30/07/2026, 30-7-26, 30.07.2026. Falls back to month-first
  // only when the first part cannot be a day-of-month reading (e.g. 07/30/26).
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    let day = +m[1], mon = +m[2], year = +m[3];
    if (!dayFirst) { const t = day; day = mon; mon = t; }
    // Whatever the header claimed, a part above 12 can only be the day.
    if (mon > 12 && day <= 12) { const t = day; day = mon; mon = t; }
    if (year < 100) year += 2000;
    if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
    return ymd(year, mon, day);
  }

  // "4-Jul-26", "July 4, 2026", etc.
  const d = new Date(s);
  if (isNaN(d)) return null;
  // A year-less string ("JULY 4") parses to year 2001 — treat that as no date
  // rather than inventing one two decades off.
  if (!/\d{4}|\d{2}\s*$|['\-/.]\s*\d{2}$/.test(s)) return null;
  return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

// "INVOICE DATE (MM/DD/YYYY)" -> "INVOICE DATE". The sheet routinely documents
// its own date format inside the header, and that hint must not stop the
// column from being recognised — an unmapped date column silently blanked
// every date in the report.
const stripHint = (s) => s.replace(/\s*\([^)]*\)\s*$/, "").trim();

/*
 * Header row -> { field: columnIndex }.
 *
 * Matching runs in three passes, strictest first: exact (with any trailing
 * "(...)" hint stripped), then prefix, then substring. Running each pass
 * across ALL fields before starting the next is what keeps it safe — a loose
 * alias like "COMMISSION" can never steal a column that "RDR COMMISSION
 * AMOUNT" matches exactly, because the exact pass has already claimed it.
 * A claimed column is never handed to a second field.
 */
function mapHeaders(headerRow) {
  const cells = headerRow.map(norm);
  const bare  = cells.map(stripHint);
  const map = {}, taken = new Set();

  const PASSES = [
    (c, b, a) => c === a || b === a,
    (c, b, a) => c.startsWith(a) || b.startsWith(a),
    // Substring is the loosest rule, so short aliases ("PJ", "WT") sit it out
    // rather than latching onto an unrelated column.
    (c, b, a) => a.length >= 4 && (c.includes(a) || b.includes(a)),
  ];

  for (const match of PASSES) {
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (map[field] != null) continue;
      for (const alias of aliases) {
        const a = norm(alias);
        const hits = [];
        for (let i = 0; i < cells.length; i++) {
          if (!taken.has(i) && match(cells[i], bare[i], a)) hits.push(i);
        }
        if (!hits.length) continue;
        const idx = PREFER_LAST.has(field) ? hits[hits.length - 1] : hits[0];
        map[field] = idx; taken.add(idx);
        break;
      }
    }
  }
  return map;
}

/*
 * Which way round an ambiguous text date reads, taken from the header itself:
 * "Invoice Date (mm/dd/yyyy)" -> month first, "(dd/mm/yyyy)" -> day first.
 * Real Excel date cells are unaffected; this only steers the text fallback.
 * With no hint we assume day-first, which is the local convention.
 */
function dayFirstFromHeader(header) {
  const m = String(header ?? "").toUpperCase().match(/\(([^)]*)\)/);
  if (!m) return true;
  const d = m[1].indexOf("D"), mo = m[1].indexOf("M");
  if (d < 0 || mo < 0) return true;
  return d < mo;
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

  const header = (aoa[headerIdx] || []).map((c) => String(c ?? "").trim());
  const dayFirst = dayFirstFromHeader(map.date != null ? header[map.date] : "");

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
    const sellerStatus = blank(get("sellerStatus")).toUpperCase();
    records.push({
      date: toISO(get("date"), dayFirst),
      invoice: String(get("invoice") ?? "").trim(),
      client,
      pjCode: String(get("pjCode") ?? "").trim(),
      itemCode: String(get("itemCode") ?? "").trim(),
      // Keep item type RAW — do NOT fold the supplier name into it, or supplier
      // data would leak into partner views through the "item type" field.
      itemType,
      supplier: supplier || "—",
      weight: num(get("weight")),
      capitalPerGram: num(get("capitalPerGram")),
      supplierPrice: num(get("supplierPrice")),
      amount,
      onelive: num(get("onelive")),
      commission: String(get("commission") ?? "").trim(),
      commissionType: String(get("commissionType") ?? "").trim(),
      commissionValue,
      sellerStatus,
      sheet: sheetName,
    });
  }
  return { records, columns: Object.keys(map), header };
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
  let masters = names.filter((n) => MASTER_SHEET_RE.test(n));
  // Among masters, keep only the COMPLETE register sheet(s): the ones mapping
  // the most columns. This drops stub tabs (e.g. a 7-column "AUGUST" draft
  // with no commission columns) whose rows would otherwise double-count —
  // while still combining multiple full-column month sheets if they exist.
  if (masters.length > 1) {
    const score = (n) => parsedByName[n].columns.length;
    const best = Math.max(...masters.map(score));
    masters = masters.filter((n) => score(n) === best);
  }
  const used = masters.length ? masters : [names[0]];

  let records = [], columns = new Set(), header = [];
  for (const n of used) {
    records = records.concat(parsedByName[n].records);
    parsedByName[n].columns.forEach((c) => columns.add(c));
    if (!header.length) header = parsedByName[n].header || [];
  }

  const dates = records.map((r) => r.date).filter(Boolean).sort();

  /* An unmapped or unparseable date column used to fail silently: the upload
   * reported "163 rows loaded" and every Date cell in the report was blank.
   * Say so out loud instead, and name the headers we could not place so the
   * spreadsheet can be corrected (or an alias added to config.js). */
  const warnings = [];
  if (!columns.has("date")) {
    warnings.push(
      "The invoice date column was not recognised, so every row loaded without a date. " +
      "Date filters and the monthly breakdown will be empty. Headers found: " +
      header.filter(Boolean).join(" | "));
  } else if (dates.length < records.length) {
    warnings.push(
      `${records.length - dates.length} of ${records.length} rows have no readable invoice date ` +
      "and will be excluded by any date filter.");
  }
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
      // Surfaced so a date column that failed to parse is visible in the
      // upload summary instead of quietly showing up as blank Date cells.
      datesParsed: dates.length,
      datesMissing: records.length - dates.length,
      header,
      warnings,
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

    // Admin/owner "By item type": item type if present, else fall back to the
    // supplier so the grouping is meaningful (they're allowed to see supplier).
    const itKey = r.itemType || r.supplier || "Unspecified";
    const t = byType.get(itKey) || { itemType: itKey, amount: 0, commissionValue: 0, weight: 0, count: 0 };
    t.amount += r.amount; t.commissionValue += r.commissionValue; t.weight += r.weight; t.count += 1;
    byType.set(itKey, t);

    // Group by commission type (Gold / Jewelry) — used for the partner view.
    const ckey = commLabel(r.commissionType);
    const ct = byCommType.get(ckey) || { itemType: ckey, amount: 0, commissionValue: 0, weight: 0, count: 0 };
    ct.amount += r.amount; ct.commissionValue += r.commissionValue; ct.weight += r.weight; ct.count += 1;
    byCommType.set(ckey, ct);

    // Undated rows have no place on a chronological trend line — including
    // them created a "—" bucket that sorted BEFORE every real month
    // (localeCompare puts "—" ahead of "2026-07"), so the line chart's first
    // point was a nonsense one instead of the earliest real month. They're
    // still counted in every other total (kpi.amount, clients, types) —
    // just not here.
    if (r.date) {
      const mk = r.date.slice(0, 7);
      const m = byMonth.get(mk) || { month: mk, amount: 0, commissionValue: 0 };
      m.amount += r.amount; m.commissionValue += r.commissionValue;
      byMonth.set(mk, m);
    }
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

// Group line items into invoices, keyed by reserve no. Newest first.
function groupInvoices(records, { from, to } = {}) {
  const rows = records.filter((r) => {
    if (from && (!r.date || r.date < from)) return false;
    if (to && (!r.date || r.date > to)) return false;
    return true;
  });
  const map = new Map();
  for (const r of rows) {
    const k = r.invoice || "(no reserve)";
    let inv = map.get(k);
    if (!inv) { inv = { reserve: k, date: r.date, clients: new Set(), items: [], amount: 0, commissionValue: 0, cost: 0, weight: 0, source: r.source || "import" }; map.set(k, inv); }
    if (r.source === "manual") inv.source = "manual";
    inv.items.push(r);
    if (r.client) inv.clients.add(r.client);
    if (r.date && (!inv.date || r.date < inv.date)) inv.date = r.date;
    inv.amount += r.amount;
    inv.commissionValue += r.commissionValue;
    inv.cost += (r.supplierPrice || (r.weight * r.capitalPerGram));
    inv.weight += r.weight;
  }
  return [...map.values()]
    .map((inv) => ({ ...inv, clients: [...inv.clients], count: inv.items.length, margin: inv.amount - inv.cost }))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.reserve.localeCompare(b.reserve));
}

module.exports = { parseWorkbookBuffer, aggregate, groupInvoices };
