const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
let CUR = "₱", ME = null, period = "all", CURRENT = null, partnerSlug = "";
const charts = {};
// Global filters — shared by Overview, register, breakdowns and invoices,
// and persisted so they survive reloads and page switches.
let filters = { q: "", commType: "", client: "" };
function saveFilters() {
  try { localStorage.setItem("pj-filters", JSON.stringify({ period, from: $("#from").value, to: $("#to").value, ...filters })); } catch (_) {}
}
function restoreFilters() {
  try {
    const s = JSON.parse(localStorage.getItem("pj-filters") || "{}");
    if (s.period) period = s.period;
    if (s.from) $("#from").value = s.from;
    if (s.to) $("#to").value = s.to;
    filters.q = s.q || ""; filters.commType = s.commType || ""; filters.client = s.client || "";
    $("#fq").value = filters.q; $("#fCommType").value = filters.commType;
    document.querySelectorAll(".seg-btn").forEach(b => b.classList.toggle("active", b.dataset.p === period));
    $("#customRange").hidden = period !== "custom";
  } catch (_) {}
}
function filterQS() {
  const qs = new URLSearchParams();
  if (partnerSlug) qs.set("partner", partnerSlug);
  const { from, to } = periodRange();
  if (from) qs.set("from", from); if (to) qs.set("to", to);
  if (filters.q) qs.set("q", filters.q);
  if (filters.commType) qs.set("commType", filters.commType);
  if (filters.client) qs.set("client", filters.client);
  return qs;
}
function refreshAll() {
  saveFilters();
  $("#fClear").hidden = !(filters.q || filters.commType || filters.client);
  renderChips();
  load();
  if (document.querySelector("#page-invoices.active")) loadInvoices();
  if (document.querySelector("#page-payments.active")) loadPayments();
}

/* Active filters, shown as removable chips.
   Drilling in from a table changes global state silently; without this the
   next screen looks like it's missing data rather than being filtered. */
function renderChips() {
  const box = $("#fChips"); if (!box) return;
  const chips = [];
  if (filters.client)   chips.push(["client", "Client", filters.client]);
  if (filters.commType) chips.push(["commType", "Type", filters.commType]);
  if (filters.q)        chips.push(["q", "Search", filters.q]);
  box.innerHTML = chips.map(([k, label, v]) =>
    `<span class="fchip">${label} <b>${esc(v)}</b><button data-chip="${k}" title="Remove">×</button></span>`).join("");
  box.querySelectorAll("[data-chip]").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.chip;
    filters[k] = "";
    if (k === "client") $("#fClient").value = "";
    if (k === "commType") $("#fCommType").value = "";
    if (k === "q") $("#fq").value = "";
    refreshAll();
  }));
}

// ── drill-down ───────────────────────────────────────────
// Any figure on screen should lead to the rows behind it. Cells are marked
// with data-drill/data-val and handled here by delegation — no inline
// onclick, so a client called O'Brien can't break the markup.
function showPage(name) { document.querySelector(`.nav-item[data-page="${name}"]`)?.click(); }

let pendingInvoice = null;                 // opened once the list has loaded
function goInvoice(no) { pendingInvoice = no; showPage("invoices"); }

function drillClient(name) {
  const sel = $("#fClient");
  if (sel && ![...sel.options].some(o => o.value === name)) sel.add(new Option(name, name));
  filters.client = name; if (sel) sel.value = name;
  showPage("register"); refreshAll();
}
function drillType(t) {
  if (isCommDim()) {
    const sel = $("#fCommType");
    const match = [...sel.options].find(o => o.value.toLowerCase() === String(t).toLowerCase());
    filters.commType = match ? match.value : t;
    sel.value = filters.commType;
  } else { filters.q = t; $("#fq").value = t; }
  showPage("register"); refreshAll();
}
function drillSearch(q) { filters.q = q; $("#fq").value = q; showPage("register"); refreshAll(); }

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-drill]"); if (!el) return;
  const v = el.dataset.val;
  ({ invoice: goInvoice, client: drillClient, type: drillType, q: drillSearch })[el.dataset.drill]?.(v);
});

/** Commission type rendered as a coloured pill — gold for GOLD, teal for
    JEWELRY — so the category is readable from the colour in the table too,
    not only in the chart. */
function typePill(value, text) {
  const t = String(value || "").toUpperCase();
  const cls = t.includes("GOLD") ? " t-gold" : t.includes("JEWEL") ? " t-jewelry" : "";
  return `<span class="pill-type${cls}">${text}</span>`;
}

/** Seller (client) payment status — PAID / UNPAID — as the same status-pill
    badge used for user status elsewhere. */
function statusPill(value) {
  const t = String(value || "").toUpperCase();
  if (t === "PAID") return `<span class="status-pill sp-active">Paid</span>`;
  if (t === "UNPAID") return `<span class="status-pill sp-inactive">Unpaid</span>`;
  return "N/A";
}

/** A clickable cell. `title` gets the hover summary where we have one. */
const drill = (kind, value, text, title) =>
  `<span class="lnk${kind === "invoice" ? " lnk-inv" : ""}" data-drill="${kind}" data-val="${escA(value)}"${
    title ? ` title="${escA(title)}"` : ""}>${text}</span>`;

/** Hover summary for a client, from the breakdown the API already sent. */
function clientTip(name) {
  const c = (CURRENT && CURRENT.clients || []).find(x => x.client === name);
  if (!c) return "Click to filter to this client";
  const bits = [`${c.invoices} invoice${c.invoices === 1 ? "" : "s"}`, `${money(c.amount)} sales`];
  if (c.commissionValue !== undefined) bits.push(`${money(c.commissionValue)} commission`);
  return bits.join(" · ") + " — click to filter";
}

const esc = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
// For values that land INSIDE an attribute. esc() alone leaves quotes intact,
// so a client written as JAS"MIN would close the attribute early and swallow
// the rest of the tag. Excel data is not trusted input.
const escA = (s) => esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const money = (n) => CUR + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const grams = (n) => (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }) + " g";
// commission rate: 0.05 -> "5%", 50 -> "₱50/g"
const fmtRate = (v) => { const n = parseFloat(v); if (isNaN(n)) return "N/A"; return n > 0 && n < 1 ? (+(n*100).toFixed(2)) + "%" : "₱" + n + "/g"; };
// display helper: blanks / dashes / em-dashes / N-A placeholders -> "N/A"
const BLANKISH = new Set(["", "-", "—", "–", "N/A", "NA", "n/a"]);
const disp = (v) => { const s = String(v ?? "").trim(); return BLANKISH.has(s) ? "N/A" : esc(s); };
const cssVar = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/* ── chart colours ────────────────────────────────────────
   Read from the stylesheet, never hardcoded, so switching to dark mode
   actually recolours the data. These used to be literal hex: indigo-600 sits
   at 2.78:1 on the dark surface, under the 3:1 floor for graphics, which made
   the sales series nearly invisible at night.
   applyTheme() re-renders the charts, so these are re-read on every switch. */
const C = (name, fallback) => cssVar(name) || fallback;
const seriesSales   = () => C("--c-sales", "#4f46e5");
const seriesJewelry = () => C("--c-jewelry", "#0f766e");
const seriesGold    = () => C("--c-gold", "#a87a2b");
const ramp = () => [1,2,3,4,5,6,7,8].map(i => C("--c-" + i, "#4f46e5"));

/* GOLD and JEWELRY are the commission types in the data, so they get a fixed
   colour rather than whichever ramp slot they happen to sort into — otherwise
   the same category changes colour when the ordering changes. */
function typeColor(label) {
  const t = String(label || "").toUpperCase();
  if (t.includes("GOLD")) return seriesGold();
  if (t.includes("JEWEL")) return seriesJewelry();
  return null;
}
/** Colours for a set of category labels: named types keep their colour, the
    rest fall through to the ramp. */
function categoryColors(labels) {
  const r = ramp();
  let next = 0;
  return labels.map(l => typeColor(l) || r[next++ % r.length]);
}
const hexA = (h, a) => {
  const m = String(h).trim().replace("#", "");
  if (m.length < 6) return h;
  return `rgba(${parseInt(m.slice(0,2),16)},${parseInt(m.slice(2,4),16)},${parseInt(m.slice(4,6),16)},${a})`;
};

// ── theme ────────────────────────────────────────────────
function applyTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem("rdr-theme", t); } catch(_){} if (CURRENT) renderCharts(); }
$("#themeToggle")?.addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
try { applyTheme(localStorage.getItem("rdr-theme") || "light"); } catch(_){}

// ── boot / session ───────────────────────────────────────
async function boot() {
  const me = await (await fetch("/api/me")).json();
  if (!me.authed) { window.location = "/login.html"; return; }
  ME = me; CUR = me.currency || "₱";
  $("#umName").textContent = me.user.name;
  $("#umEmail").textContent = me.user.email;
  $("#roleText").textContent = { admin: "Accounting admin", owner: "Owner", partner: "Partner" }[me.user.role] || me.user.role;
  $("#roleBadge").hidden = false;

  const isAdmin = me.user.role === "admin";
  const isOwnerOrAdmin = isAdmin || me.user.role === "owner";
  $("#uploadBtn").hidden = !isAdmin;
  $("#btnNewInvoice").hidden = !isAdmin;
  $("#adminNav").hidden = !isOwnerOrAdmin;
  $$("[data-admin]").forEach(el => el.hidden = !isAdmin);

  // partner switcher (admin/owner). Partners see only their own — no switcher.
  const sw = $("#partnerSwitch");
  sw.innerHTML = me.partners.map(p => `<option value="${p.slug}">${esc(p.name)}</option>`).join("");
  partnerSlug = me.partners[0] ? me.partners[0].slug : "";
  $("#partnerSwitchWrap").hidden = me.user.role === "partner" || me.partners.length <= 1;
  sw.value = partnerSlug;
  sw.addEventListener("change", () => { partnerSlug = sw.value; renderBrandText(); renderBrandMark(); filters.client = ""; $("#fClient").value = ""; refreshAll(); });
  renderBrandText();
  renderBrandMark();

  if (isAdmin) { fillPartnerSelect("#uploadPartner"); fillPartnerSelect("#nuPartner"); }
  restoreFilters();
  refreshAll();
}

const isCommDim = () => CURRENT && CURRENT.typeDimension === "commission";
const typeLabel = () => (isCommDim() ? "commission type" : "item type");

function fillPartnerSelect(sel) {
  $(sel).innerHTML = ME.partners.map(p => `<option value="${p.slug}">${esc(p.name)}</option>`).join("");
}

// Header mark: what it shows depends on who's signed in, not on which
// partner's data happens to be on screen.
//  - admin / owner / superadmin → always the Perfect Jewel mark. These roles
//    can switch the partner filter to look at anyone's numbers, but the
//    logo identifies the account that's logged in, so it stays fixed.
//  - partner → their own logo (or initials, if none is set). Partner
//    accounts have no switcher, so this is always just "their" logo.
function initialsOf(name) {
  return String(name || "").split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0]).join("").toUpperCase() || "•";
}

const GENERIC_BRAND = "Secret Supplier";
// The generic placeholder name exists for RDR's confidentiality — admin/owner
// always see it (it identifies the account logged in, not the data on
// screen), and so does RDR's own partner login. Any other partner should see
// their own real name instead, not a leftover RDR-specific codename.
function renderBrandText() {
  const p = (ME.partners || []).find(x => x.slug === partnerSlug);
  const showGeneric = ME.user.role !== "partner" || partnerSlug === "rdr";
  $("#brandText").textContent = showGeneric ? GENERIC_BRAND : ((p && p.name) || GENERIC_BRAND);
  $("#brandSub").textContent = showGeneric ? ((p && p.name) || "") : "Partner sales & commission";
}
function renderBrandMark() {
  const mark = $("#brandMark");
  const old = mark.querySelector("img"); if (old) old.remove();
  mark.classList.remove("has-img");

  if (ME.user.role !== "partner") {
    $("#brandInitials").textContent = "PJ";
    const img = new Image();
    img.alt = "Perfect Jewel";
    img.onload = () => mark.classList.add("has-img");
    img.onerror = () => img.remove();
    img.src = "/logos/pj-logo.png";
    mark.appendChild(img);
    return;
  }

  const p = (ME.partners || []).find(x => x.slug === partnerSlug);
  $("#brandInitials").textContent = initialsOf(p && p.name);
  if (p && p.hasLogo) {
    const img = new Image();
    img.alt = p.name + " logo";
    img.onload = () => mark.classList.add("has-img");
    img.onerror = () => img.remove();
    img.src = `/api/partner-logo?partner=${encodeURIComponent(p.slug)}&t=${Date.now()}`;
    mark.appendChild(img);
  }
}

// ── nav ──────────────────────────────────────────────────
$$(".nav-item").forEach(b => b.addEventListener("click", () => {
  $$(".nav-item").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  $$(".page").forEach(p => p.classList.remove("active"));
  $("#page-" + b.dataset.page).classList.add("active");
  const rep = ["overview","register","clients","types","invoices"].includes(b.dataset.page);
  $("#filterBar").hidden = !rep || !CURRENT;
  if (b.dataset.page === "portfolio") loadPortfolio();
  if (b.dataset.page === "partners") loadPartners();
  if (b.dataset.page === "users") loadUsers();
  if (b.dataset.page === "invoices") loadInvoices();
  if (b.dataset.page === "payments") loadPayments();
}));

// ── period + filters ─────────────────────────────────────
$("#periodSeg")?.addEventListener("click", (e) => {
  const b = e.target.closest(".seg-btn"); if (!b) return;
  $$(".seg-btn").forEach(x => x.classList.remove("active")); b.classList.add("active");
  period = b.dataset.p; $("#customRange").hidden = period !== "custom";
  if (period !== "custom") refreshAll();
});
$("#from")?.addEventListener("change", refreshAll);
$("#to")?.addEventListener("change", refreshAll);
let fqTimer;
$("#fq")?.addEventListener("input", () => {
  clearTimeout(fqTimer);
  fqTimer = setTimeout(() => { filters.q = $("#fq").value.trim(); refreshAll(); }, 250);
});
$("#fCommType")?.addEventListener("change", () => { filters.commType = $("#fCommType").value; refreshAll(); });
$("#fClient")?.addEventListener("change", () => { filters.client = $("#fClient").value; refreshAll(); });
$("#fClear")?.addEventListener("click", () => {
  filters = { q: "", commType: "", client: "" };
  $("#fq").value = ""; $("#fCommType").value = ""; $("#fClient").value = "";
  refreshAll();
});
function periodRange() {
  const now = new Date(), y = now.getFullYear(), iso = (d) => d.toISOString().slice(0,10);
  if (period === "ytd") return { from: `${y}-01-01`, to: iso(now) };
  if (period === "month") return { from: iso(new Date(y, now.getMonth(), 1)), to: iso(now) };
  if (period === "quarter") { const q = Math.floor(now.getMonth()/3)*3; return { from: iso(new Date(y, q, 1)), to: iso(now) }; }
  if (period === "custom") return { from: $("#from").value, to: $("#to").value };
  return {};
}

// ── report ───────────────────────────────────────────────
async function load() {
  const data = await (await fetch("/api/report?" + filterQS().toString())).json();
  if (data.empty || !data.meta) {
    CURRENT = null; $("#overviewContent").hidden = true; $("#filterBar").hidden = true;
    $("#emptyState").hidden = false;
    $("#emptyText").textContent = data.reason === "no partner assigned"
      ? "No partner assigned to your account yet." : "No report loaded yet for this partner.";
    $("#emptyUpload").hidden = ME.user.role !== "admin";
    $("#updatedFoot").textContent = "—";
    return;
  }
  CURRENT = data;
  $("#emptyState").hidden = true; $("#overviewContent").hidden = false; $("#filterBar").hidden = false;
  $("#updatedFoot").textContent = data.meta ? "Updated " + data.meta.uploadedAt.slice(0,10) : "—";
  $("#ncRows").textContent = data.rowsTotal.toLocaleString();
  $("#ncClients").textContent = data.clients.length;
  $("#ncTypes").textContent = data.types.length;
  // (Re)populate the client filter from the unfiltered dataset, keeping selection.
  if (data.filterOptions) {
    const sel = $("#fClient"), cur = filters.client;
    sel.innerHTML = `<option value="">All clients</option>` +
      data.filterOptions.clients.map(c => `<option value="${escA(c)}">${esc(c)}</option>`).join("");
    sel.value = cur && data.filterOptions.clients.includes(cur) ? cur : "";
  }
  renderKPIs(); renderCharts(); renderTables();
}

function renderKPIs() {
  const k = CURRENT.kpi, cards = [];
  cards.push({ label: "Total sales", value: money(k.amount), cls: "", sub: `${k.lines.toLocaleString()} line items` });
  if (k.commissionValue !== undefined) cards.push({ label: "Commission", value: money(k.commissionValue), cls: "accent",
    sub: k.commissionValue ? `${(k.commissionValue/k.amount*100).toFixed(1)}% of sales` : "not filled in yet" });
  cards.push({ label: "Invoices", value: k.invoices.toLocaleString(), cls: "", sub: `${k.clients} clients` });
  if (k.cost !== undefined) cards.push({ label: "Supplier cost", value: money(k.cost), cls: "", sub: "capital / cost basis" });
  if (k.margin !== undefined) cards.push({ label: "Est. gross margin", value: money(k.margin), cls: "teal", sub: `${(k.margin/k.amount*100).toFixed(1)}% of sales` });
  if (k.onelive !== undefined) cards.push({ label: "ONELIVE profit", value: money(k.onelive), cls: "", sub: "Perfect Jewel share" });
  cards.push({ label: "Total weight", value: grams(k.weight), cls: "", sub: "gold items" });
  // Balance payable is all-time (not affected by the date filter) — it's what
  // we still owe this partner overall.
  if (CURRENT.payout) {
    const owing = CURRENT.payout.balance > 0.005;
    cards.push({ label: "Balance payable", value: money(CURRENT.payout.balance),
      cls: owing ? "balance-due" : "balance-clear",
      sub: `${money(CURRENT.payout.paid)} paid of ${money(CURRENT.payout.earned)}` });
  }
  $("#kpis").innerHTML = cards.map(c => `<div class="kpi-card"><div class="kpi-label">${c.label}</div><div class="kpi-value ${c.cls}">${c.value}</div><div class="kpi-sub">${c.sub}</div></div>`).join("");
}

function mk(id, cfg) { if (charts[id]) charts[id].destroy(); charts[id] = new Chart($("#"+id), cfg); }

/* Charts drill too: clicking a bar or a slice filters to what it represents.
   `fn` receives the label under the cursor. */
function clickable(fn) {
  return {
    onClick: (evt, els, chart) => {
      if (!els.length) return;
      fn(chart.data.labels[els[0].index]);
    },
    onHover: (evt, els) => { evt.native.target.style.cursor = els.length ? "pointer" : "default"; },
  };
}
function renderCharts() {
  const tick = cssVar("--muted") || "#78716c", grid = cssVar("--border") || "rgba(0,0,0,.06)";
  const tt = $("#typeChartTitle"); if (tt) tt.textContent = "Sales by " + typeLabel();
  const hasComm = CURRENT.kpi.commissionValue !== undefined;
  const m = CURRENT.months;
  const cSales = seriesSales(), cComm = seriesJewelry();
  const ds = [{ label: "Sales", data: m.map(x=>x.amount), borderColor: cSales, backgroundColor: hexA(cSales, .12), fill: true, tension: .35, borderWidth: 2, pointRadius: 2, yAxisID: "y" }];
  if (hasComm) ds.push({ label: "Commission", data: m.map(x=>x.commissionValue||0), borderColor: cComm, backgroundColor: hexA(cComm, .10), fill: true, tension: .35, borderWidth: 2, pointRadius: 2, yAxisID: "y1" });
  mk("chTime", { type: "line", data: { labels: m.map(x=>x.month), datasets: ds },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: cssVar("--muted2") } } },
      scales: { x: { ticks:{color:tick}, grid:{color:grid} },
        y: { position:"left", ticks:{color:tick, callback:v=>CUR+(v/1000)+"k"}, grid:{color:grid} },
        y1: { position:"right", display: hasComm, ticks:{color:tick, callback:v=>CUR+(v/1000)+"k"}, grid:{drawOnChartArea:false} } } } });

  const types = CURRENT.types.slice(0,8);
  const typeLabels = types.map(t=>t.itemType);
  mk("chType", { type: "doughnut", data: { labels: typeLabels, datasets: [{ data: types.map(t=>t.amount),
      backgroundColor: categoryColors(typeLabels),
      borderColor: cssVar("--surface") || "#fff", borderWidth: 2 }] },
    options: { ...clickable(drillType), responsive: true, maintainAspectRatio: false, cutout: "62%", plugins: { legend: { position: "right", labels: { color: cssVar("--muted2"), boxWidth: 12, font:{size:11} } } } } });

  const cl = CURRENT.clients.slice(0,10);
  mk("chClient", { type: "bar", data: { labels: cl.map(c=>c.client), datasets: [{ data: cl.map(c=>c.amount), backgroundColor: seriesSales(), borderRadius: 4 }] },
    options: { ...clickable(drillClient), responsive: true, maintainAspectRatio: false, indexAxis: "y", plugins: { legend: { display: false } }, scales: { x:{ticks:{color:tick},grid:{color:grid}}, y:{ticks:{color:tick,font:{size:11}},grid:{display:false}} } } });

  $("#commCard").hidden = !hasComm;
  if (hasComm) {
    const cc = [...CURRENT.clients].sort((a,b)=>(b.commissionValue||0)-(a.commissionValue||0)).slice(0,10);
    mk("chComm", { type: "bar", data: { labels: cc.map(c=>c.client), datasets: [{ data: cc.map(c=>c.commissionValue||0), backgroundColor: seriesJewelry(), borderRadius: 4 }] },
      options: { ...clickable(drillClient), responsive: true, maintainAspectRatio: false, indexAxis: "y", plugins: { legend: { display: false } }, scales: { x:{ticks:{color:tick},grid:{color:grid}}, y:{ticks:{color:tick,font:{size:11}},grid:{display:false}} } } });
  }
}

// ── tables (columns adapt to what the API returned) ──────
// Sortable: click a header to sort asc, again for desc. "__n" renders the
// 1-based row number (of the sorted view) and isn't sortable.
const SORT = {};        // el -> { key, dir }
const TABLE_ARGS = {};  // el -> args, so a header click can re-render
function smartCompare(av, bv) {
  const a = av ?? "", b = bv ?? "";
  if (typeof a === "string" && typeof b === "string") {
    const ad = Date.parse(a), bd = Date.parse(b);
    if (!Number.isNaN(ad) && !Number.isNaN(bd)) return ad - bd;
  }
  const an = typeof av === "number", bn = typeof bv === "number";
  if (an || bn) return (av || 0) - (bv || 0);
  const af = parseFloat(av), bf = parseFloat(bv);
  if (!isNaN(af) && !isNaN(bf)) return af - bf;
  return String(a).localeCompare(String(b));
}
function table(el, cols, rows, cellFn, foot) {
  TABLE_ARGS[el] = { cols, rows, cellFn, foot };
  const st = SORT[el];
  let view = rows;
  if (st && st.key) {
    view = [...rows].sort((a, b) => (st.dir === "desc" ? -1 : 1) * smartCompare(a[st.key], b[st.key]));
  }
  const head = `<thead><tr>${cols.map(c => {
    const sortable = c[0] !== "__n";
    const cls = [c[2]==="num"?"num":"", st && st.key===c[0] ? (st.dir==="desc"?"sorted-desc":"sorted-asc") : ""].join(" ").trim();
    return `<th class="${cls}" ${sortable?`data-key="${c[0]}"`:""}>${c[1]}</th>`;
  }).join("")}</tr></thead>`;
  const body = `<tbody>${view.map((r, i) => `<tr>${cols.map(c => `<td class="${c[2]==='num'?'num':''}${c[0]==='__n'?' rownum':''}">${c[0]==="__n" ? (i+1) : cellFn(r,c[0],c[2],i)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  $(el).innerHTML = head + body + (foot || "");
  $(el).querySelectorAll("th[data-key]").forEach(th => th.addEventListener("click", () => {
    const k = th.dataset.key, cur = SORT[el] || {};
    SORT[el] = cur.key === k ? { key: k, dir: cur.dir === "asc" ? "desc" : "asc" } : { key: k, dir: "asc" };
    const a = TABLE_ARGS[el];
    table(el, a.cols, a.rows, a.cellFn, a.foot);
  }));
}
function renderTables() {
  const r0 = CURRENT.rows[0] || {};
  // Columns are driven by what the API returns — the server omits anything this
  // viewer isn't allowed to see (e.g. supplier is absent for partners).
  const regCols = [["__n","#"],["date","Date"],["invoice","Invoice #"]];
  if ("pjCode" in r0) regCols.push(["pjCode","PJ code"]);
  if ("itemCode" in r0) regCols.push(["itemCode","Item code"]);
  if ("itemType" in r0) regCols.push(["itemType","Item type"]);
  regCols.push(["client","Client"]);
  if ("commissionType" in r0) regCols.push(["commissionType","Comm. type"]);
  regCols.push(["weight","Weight","num"]);
  if ("supplierPrice" in r0) regCols.push(["supplierPrice","Capital","num"]);
  if ("capitalPerGram" in r0) regCols.push(["capitalPerGram","₱/g","num"]);
  regCols.push(["amount","Item amount","num"]);
  if ("commissionRate" in r0) regCols.push(["commissionRate","Comm. rate"]);
  if ("commissionValue" in r0) regCols.push(["commissionValue","Commission amount","num"]);
  if ("sellerStatus" in r0) regCols.push(["sellerStatus","Seller status"]);

  // Totals row over the FULL filtered set (server-computed).
  const T = CURRENT.totals || {};
  const footCells = regCols.map(([k]) => {
    if (k === "__n") return `<td class="rownum"></td>`;
    if (k === "date") return `<td><b>TOTAL</b></td>`;
    if (k === "invoice") return `<td>${(T.count ?? CURRENT.rowsTotal).toLocaleString()} rows</td>`;
    if (k === "weight") return `<td class="num"><b>${grams(T.weight || 0)}</b></td>`;
    if (k === "supplierPrice" && T.supplierPrice !== undefined) return `<td class="num"><b>${money(T.supplierPrice)}</b></td>`;
    if (k === "amount") return `<td class="num"><b>${money(T.amount || 0)}</b></td>`;
    if (k === "commissionValue" && T.commissionValue !== undefined) return `<td class="num"><b>${money(T.commissionValue)}</b></td>`;
    return "<td></td>";
  });
  const foot = `<tfoot><tr>${footCells.join("")}</tr></tfoot>`;

  // Cell renderer for the register. Identifier columns become drill-throughs:
  // invoice -> that invoice, client -> filter, PJ/item code -> search.
  const regCell = (r, k, kind) => {
    if (kind === "num") return k === "weight" ? (r[k] ? grams(r[k]) : "N/A") : (r[k] ? money(r[k]) : "N/A");
    if (k === "commissionRate") return fmtRate(r[k]);
    if (k === "sellerStatus") return statusPill(r[k]);
    const text = disp(r[k]);
    if (text === "N/A") return text;
    if (k === "invoice") return drill("invoice", r[k], text, "Open invoice " + r[k]);
    if (k === "client")  return drill("client", r[k], text, clientTip(r[k]));
    if (k === "pjCode" || k === "itemCode") return drill("q", r[k], text, "Find every row with this code");
    if (k === "commissionType" || k === "itemType") return drill("type", r[k], typePill(r[k], text), "Filter to " + text);
    return text;
  };
  table("#tblRegister", regCols, CURRENT.rows, regCell, foot);

  const c0 = CURRENT.clients[0] || {};
  const clientCols = [["client","Client"],["invoices","Invoices","num"],["amount","Sales","num"]];
  if ("commissionValue" in c0) clientCols.push(["commissionValue","Commission","num"]);
  if ("cost" in c0) clientCols.push(["cost","Cost","num"]);
  if ("margin" in c0) clientCols.push(["margin","Margin","num"]);
  table("#tblClients", clientCols, CURRENT.clients, (r,k,kind) => kind==="num"
    ? (k==="invoices" ? drill("client", r.client, r[k], `See ${r.client}'s ${r[k]} invoices`) : money(r[k]))
    : drill("client", r[k], esc(r[k]), clientTip(r[k])));

  const t0 = CURRENT.types[0] || {};
  const typeCols = [["itemType", isCommDim() ? "Commission type" : "Item type"],["count","Items","num"],["weight","Weight","num"],["amount","Sales","num"]];
  if ("commissionValue" in t0) typeCols.push(["commissionValue","Commission","num"]);
  table("#tblTypes", typeCols, CURRENT.types, (r,k,kind) => kind==="num" ? (k==="count"?r[k]:k==="weight"?grams(r[k]):money(r[k])) : drill("type", r[k], typePill(r[k], esc(r[k])), "Filter to " + r[k]));
}

function downloadCSV() {
  if (!CURRENT) return;
  const r0 = CURRENT.rows[0] || {};
  const cols = Object.keys(r0);
  const rows = [cols].concat(CURRENT.rows.map(r => cols.map(c => r[c])));
  const csv = rows.map(r => r.map(c => `"${String(c ?? "").replace(/"/g,'""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  a.download = `${partnerSlug||"report"}-sales-register.csv`; a.click();
}

// ── invoices ─────────────────────────────────────────────
let currentInvoice = null;
async function loadInvoices() {
  const d = await (await fetch("/api/invoices?" + filterQS().toString())).json();
  $("#ncInvoices").textContent = (d.invoices || []).length;
  if (!d.invoices || !d.invoices.length) {
    pendingInvoice = null;
    $("#invList").innerHTML = `<div class="page-sub" style="padding:16px;">No invoices match the current filters.</div>`;
    return;
  }
  $("#invList").innerHTML = d.invoices.map(inv => `
    <div class="inv-row" data-reserve="${esc(inv.reserve)}" onclick="openInvoice('${inv.reserve.replace(/'/g,"\\'")}')">
      <div class="inv-row-top"><span class="inv-res">${esc(inv.reserve)}</span>${
        inv.source === "manual" ? '<span class="pill-manual" title="created in this system">manual</span>' : ''
      }${inv.hasProof ? '<span class="inv-clip" title="has proof">📎</span>' : ''}</div>
      <div class="inv-row-sub">${esc(inv.clients.join(", ")) || "N/A"}</div>
      <div class="inv-row-meta"><span>${inv.date || "N/A"}</span><span>${inv.count} item${inv.count>1?"s":""}</span><span class="mono">${money(inv.amount)}</span></div>
    </div>`).join("");

  // Someone clicked an invoice number elsewhere — open it now the list is here.
  if (pendingInvoice) {
    const no = pendingInvoice; pendingInvoice = null;
    await openInvoice(no);
    document.querySelector(`.inv-row.active`)?.scrollIntoView({ block: "center" });
  }
}

async function openInvoice(reserve) {
  document.querySelectorAll(".inv-row").forEach(r => r.classList.toggle("active", r.dataset.reserve === reserve));
  const qs = new URLSearchParams(); if (partnerSlug) qs.set("partner", partnerSlug); qs.set("reserve", reserve);
  const d = await (await fetch("/api/invoice?" + qs)).json();
  if (d.error) { $("#invDetail").innerHTML = `<div class="empty-state"><div class="empty-text">${esc(d.error)}</div></div>`; return; }
  currentInvoice = d;
  const t = d.totals, i0 = d.items[0] || {};

  const cols = [["pjCode","PJ code"],["itemCode","Item code"],["itemType","Type"]];
  if ("commissionType" in i0) cols.push(["commissionType","Comm. type"]);
  cols.push(["weight","Weight","num"]);
  if ("supplierPrice" in i0) cols.push(["supplierPrice","Capital","num"]);
  cols.push(["amount","Item amount","num"]);
  if ("commissionRate" in i0) cols.push(["commissionRate","Comm. rate"]);
  if ("commissionValue" in i0) cols.push(["commissionValue","Commission amount","num"]);
  if ("sellerStatus" in i0) cols.push(["sellerStatus","Seller status"]);
  cols.unshift(["__n","#"]);
  const cell = (it, k, kind) => {
    if (kind === "num") return k === "weight" ? (it[k] ? grams(it[k]) : "N/A") : (it[k] ? money(it[k]) : "N/A");
    if (k === "commissionRate") return fmtRate(it[k]);
    if (k === "sellerStatus") return statusPill(it[k]);
    const text = disp(it[k]);
    if (text === "N/A") return text;
    if (k === "pjCode" || k === "itemCode") return drill("q", it[k], text, "Find every row with this code");
    if (k === "commissionType" || k === "itemType") return drill("type", it[k], typePill(it[k], text), "Filter to " + text);
    return text;
  };
  const head = `<thead><tr>${cols.map(c=>`<th class="${c[2]==='num'?'num':''}">${c[1]}</th>`).join("")}</tr></thead>`;
  const body = `<tbody>${d.items.map((it,i)=>`<tr>${cols.map(c=>`<td class="${c[2]==='num'?'num':''}${c[0]==='__n'?' rownum':''}">${c[0]==="__n" ? (i+1) : cell(it,c[0],c[2])}</td>`).join("")}</tr>`).join("")}</tbody>`;

  const chips = [`<div class="inv-tot"><div class="kpi-label">Item amount</div><div class="inv-tot-v">${money(t.amount)}</div></div>`];
  if (t.commissionValue !== undefined) chips.push(`<div class="inv-tot"><div class="kpi-label">Commission amount</div><div class="inv-tot-v accent">${money(t.commissionValue)}</div></div>`);
  if (t.cost !== undefined) chips.push(`<div class="inv-tot"><div class="kpi-label">Cost</div><div class="inv-tot-v">${money(t.cost)}</div></div>`);
  if (t.margin !== undefined) chips.push(`<div class="inv-tot"><div class="kpi-label">Margin</div><div class="inv-tot-v teal">${money(t.margin)}</div></div>`);

  let proofHtml = d.proof
    ? `<img class="inv-proof-img" src="${d.proof.url}" alt="invoice proof"><div class="page-sub" style="margin-top:6px;">Uploaded ${d.proof.uploadedAt.slice(0,10)}</div>`
    : `<div class="inv-proof-empty">No proof of invoice uploaded yet.</div>`;
  if (d.canUpload) proofHtml += `<div style="margin-top:12px;">
      <input type="file" id="proofFile" accept="image/*">
      <button class="btn btn-primary btn-sm" style="margin-top:8px;" onclick="uploadProof('${reserve.replace(/'/g,"\\'")}')">${d.proof?"Replace":"Upload"} proof</button>
      <div id="proofMsg" class="page-sub" style="margin-top:6px;"></div></div>`;

  $("#invDetail").innerHTML = `
    <div class="inv-head">
      ${d.canEdit ? `<button class="btn btn-ghost btn-sm" style="float:right"
           onclick="editInvoice('${d.reserve.replace(/'/g,"\\'")}')">Edit invoice</button>` : ""}
      <div class="inv-eyebrow">Invoice no.${d.source === "manual" ? ' <span class="pill-manual">manual</span>' : ""}</div>
      <div class="inv-reserve">${esc(d.reserve)}</div>
      <div class="inv-headmeta">${d.date || "N/A"} · ${
        d.clients.length ? d.clients.map(c => drill("client", c, esc(c), clientTip(c))).join(", ") : "N/A"
      } · ${t.count} item${t.count>1?"s":""}</div>
    </div>
    <div class="inv-body">
      <div class="inv-items">
        <div class="inv-tots">${chips.join("")}</div>
        <div class="table-wrap" style="border:1px solid var(--border); border-radius:var(--r-lg);"><table>${head}${body}</table></div>
      </div>
      <div class="inv-proof">
        <div class="section-heading">Proof of invoice</div>
        ${proofHtml}
      </div>
    </div>`;
}

async function uploadProof(reserve) {
  const f = $("#proofFile").files[0];
  if (!f) { $("#proofMsg").textContent = "Choose an image first."; return; }
  const fd = new FormData(); fd.append("file", f); fd.append("partner", partnerSlug); fd.append("reserve", reserve);
  $("#proofMsg").textContent = "Uploading…";
  const r = await (await fetch("/api/invoice-proof", { method:"POST", body: fd })).json();
  if (r.ok) { await openInvoice(reserve); loadInvoices(); }
  else $("#proofMsg").textContent = "Failed: " + (r.error || "unknown");
}

// ── owner / admin portfolio ──────────────────────────────
async function loadPortfolio() {
  const { from, to } = periodRange();
  const qs = new URLSearchParams(); if (from) qs.set("from",from); if (to) qs.set("to",to);
  const d = await (await fetch("/api/portfolio?" + qs.toString())).json();
  const g = d.grand;
  const cards = [
    { label: "Total sales (all partners)", value: money(g.amount), cls: "" },
    { label: "Total commission", value: money(g.commissionValue), cls: "accent" },
    { label: "ONELIVE profit", value: money(g.onelive), cls: "teal" },
    { label: "Gross margin", value: money(g.margin), cls: "" },
    { label: "Invoices", value: g.invoices.toLocaleString(), cls: "" },
  ];
  $("#pfKpis").innerHTML = cards.map(c => `<div class="kpi-card"><div class="kpi-label">${c.label}</div><div class="kpi-value ${c.cls}">${c.value}</div></div>`).join("");
  const tick = cssVar("--muted"), grid = cssVar("--border");
  mk("chPartners", { type: "bar", data: { labels: d.partners.map(p=>p.name), datasets: [
      { label: "Sales", data: d.partners.map(p=>p.amount), backgroundColor: seriesSales(), borderRadius: 4 },
      { label: "ONELIVE profit", data: d.partners.map(p=>p.onelive), backgroundColor: seriesJewelry(), borderRadius: 4 } ] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: cssVar("--muted2") } } }, scales: { x:{ticks:{color:tick},grid:{display:false}}, y:{ticks:{color:tick,callback:v=>CUR+(v/1000)+"k"},grid:{color:grid}} } } });
  const cols = [["name","Partner"],["invoices","Invoices","num"],["amount","Sales","num"],["commissionValue","Commission","num"],["cost","Cost","num"],["margin","Margin","num"],["onelive","ONELIVE profit","num"]];
  table("#tblPortfolio", cols, d.partners, (r,k,kind)=> kind==="num" ? (k==="invoices"?r[k]:money(r[k])) : esc(r[k]));
}

// ── admin: partners ──────────────────────────────────────
let partnersCache = [];
async function loadPartners() {
  const d = await (await fetch("/api/partners")).json();
  partnersCache = d.partners;
  $("#partnersList").innerHTML = d.partners.map(p => {
    const f = p.flags || {};
    const cb = (key,label) => `<label><input type="checkbox" data-slug="${p.slug}" data-flag="${key}" ${f[key]?"checked":""}> ${label}</label>`;
    const fileInfo = p.dataset
      ? `<div class="page-sub" style="margin-top:6px;">📄 ${esc(p.dataset.fileName || "unnamed file")} — ${p.dataset.rows.toLocaleString()} rows, uploaded ${p.dataset.uploadedAt.slice(0,10)}<br><span class="mono" style="font-size:11px;">${esc(p.dataset.path)}</span></div>`
      : `<div class="page-sub" style="margin-top:6px;">No file uploaded yet.</div>`;
    const hasLogo = (ME.partners.find(x => x.slug === p.slug) || {}).hasLogo;
    return `<div class="partner-row">
      <div class="pr-head">
        <div class="pr-logo">${hasLogo
          ? `<img src="/api/partner-logo?partner=${encodeURIComponent(p.slug)}&t=${Date.now()}" alt="">`
          : `<span>${esc(initialsOf(p.name))}</span>`}</div>
        <div style="flex:1; min-width:0;">
          <div class="pr-name">${esc(p.name)} <span class="page-sub">/${p.slug}</span></div>
          <div class="page-sub">Shown in the header when viewing this partner.</div>
        </div>
        <div class="pr-logo-actions">
          <input type="file" id="logoFile-${p.slug}" accept="image/*">
          <button class="btn btn-ghost btn-sm" onclick="uploadLogo('${p.slug}')">${hasLogo?"Replace":"Upload"} logo</button>
        </div>
      </div>
      ${fileInfo}
      <div class="page-sub" style="margin:8px 0 6px;">What this partner may see:</div>
      <div class="flag-toggles">${cb("commission","Their commission")}${cb("cost","Supplier cost")}${cb("margin","Gross margin")}${cb("onelive","ONELIVE profit")}</div></div>`;
  }).join("") || `<div class="page-sub">No partners yet.</div>`;
  $$("#partnersList input[type=checkbox]").forEach(cb => cb.addEventListener("change", async () => {
    const flags = {}; flags[cb.dataset.flag] = cb.checked;
    await fetch("/api/partners/" + cb.dataset.slug, { method:"PATCH", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ flags }) });
  }));
}
async function uploadLogo(slug) {
  const f = $("#logoFile-" + slug).files[0];
  if (!f) { alert("Choose an image first."); return; }
  const fd = new FormData(); fd.append("file", f); fd.append("partner", slug);
  const r = await (await fetch("/api/partner-logo", { method: "POST", body: fd })).json();
  if (!r.ok) { alert("Upload failed: " + (r.error || "unknown")); return; }
  const me = await (await fetch("/api/me")).json(); ME.partners = me.partners;   // refresh hasLogo
  renderBrandMark(); loadPartners();
}

$("#addPartner")?.addEventListener("click", async () => {
  const name = $("#newPartnerName").value.trim(); if (!name) return;
  await fetch("/api/partners", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ name }) });
  $("#newPartnerName").value = ""; const me = await (await fetch("/api/me")).json(); ME.partners = me.partners;
  fillPartnerSelect("#uploadPartner"); fillPartnerSelect("#nuPartner"); loadPartners();
});

// ── admin: users ─────────────────────────────────────────
let showArchivedUsers = false;
async function loadUsers() {
  const d = await (await fetch("/api/users?archived=" + (showArchivedUsers ? "1" : "0"))).json();
  const canPriv = !!d.canManagePrivileged;          // superadmin only
  const cols = [["name","Name"],["email","Email"],["role","Role"],["partner","Partner"],["status","Status"],["act","",""]];

  const body = d.users.map(u => {
    // Mirror the server rules so the UI doesn't offer buttons that will 403.
    const privileged = u.role === "admin" || u.role === "owner";
    const isSelf = ME && ME.user && ME.user.id === u.id;
    const locked = u.superadmin || (privileged && !canPriv);
    const acts = [];
    const iAmSuper = !!(ME && ME.user && ME.user.superadmin);
    if (!locked) acts.push(`<button class="btn btn-ghost btn-sm" onclick="resetPw('${u.id}')">Reset pw</button>`);
    if (!locked && !isSelf) {
      acts.push(`<button class="btn btn-ghost btn-sm" onclick="toggleUser('${u.id}',${u.disabled?false:true})">${u.disabled?"Enable":"Disable"}</button>`);
      acts.push(u.archivedAt
        ? `<button class="btn btn-ghost btn-sm" onclick="archiveUser('${u.id}',false)">Restore</button>`
        : `<button class="btn btn-ghost btn-sm btn-danger-ghost" onclick="archiveUser('${u.id}',true)">Archive</button>`);
    }
    // Hard delete is superadmin-only; archiving is the normal route.
    if (iAmSuper && !u.superadmin && !isSelf) {
      acts.push(`<button class="btn btn-ghost btn-sm btn-danger-ghost" onclick="deleteUser('${u.id}')">Delete</button>`);
    }
    if (!acts.length) acts.push(`<span class="page-sub">${u.superadmin ? "protected" : isSelf ? "you" : "read-only"}</span>`);

    const status = u.archivedAt ? '<span class="status-pill sp-inactive">archived</span>'
      : u.disabled ? '<span class="status-pill sp-inactive">disabled</span>'
      : '<span class="status-pill sp-active">active</span>';

    return `<tr${u.archivedAt ? ' class="row-archived"' : ""}>
      <td>${esc(u.name)}${u.superadmin ? ' <span class="pill-super" title="Pinned to SUPERADMIN_EMAIL in the environment; cannot be changed from the app">superadmin</span>' : ""}</td>
      <td class="mono">${esc(u.email)}</td><td>${u.role}</td><td>${esc(u.partner||"—")}</td>
      <td>${status}${u.mustChange?' <span class="page-sub">(temp pw)</span>':''}</td>
      <td>${acts.join(" ")}</td>
    </tr>`;
  }).join("");

  $("#tblUsers").innerHTML = `<thead><tr>${cols.map(c=>`<th>${c[1]}</th>`).join("")}</tr></thead><tbody>${body}</tbody>`;

  // Only a superadmin can create admins/owners, so trim the role picker.
  const roleSel = $("#nuRole");
  if (roleSel) {
    [...roleSel.options].forEach(o => {
      if (o.value === "admin" || o.value === "owner") o.hidden = !canPriv;
    });
    if (!canPriv && (roleSel.value === "admin" || roleSel.value === "owner")) {
      roleSel.value = "partner";
      roleSel.dispatchEvent(new Event("change"));
    }
  }
  const hint = $("#userScopeHint");
  if (hint) hint.textContent = canPriv
    ? "You are the superadmin: you can manage every account."
    : "You can manage partner accounts. Admin and owner accounts are superadmin-only.";
}

/* Permanent deletion. Archiving is the normal way to remove an account, so
   this asks twice: once showing what the account has touched, and once for
   the email typed exactly — which is also what the API requires. */
async function deleteUser(id) {
  const info = await (await fetch(`/api/users/${id}/activity`)).json();
  if (!info.ok) { alert(info.error || "Could not read that account."); return; }
  const a = info.activity;

  const history = a.total
    ? `\n\nThis account is on ${a.total} existing record${a.total === 1 ? "" : "s"}:` +
      `\n  · ${a.audits} audit entr${a.audits === 1 ? "y" : "ies"}` +
      `\n  · ${a.records} invoice line${a.records === 1 ? "" : "s"}` +
      `\n  · ${a.payments} payment${a.payments === 1 ? "" : "s"}` +
      `\n\nThose entries will keep their email but no longer match an account.` +
      `\nArchiving instead would keep the link intact.`
    : "\n\nThis account has no history, so nothing else is affected.";

  const typed = prompt(
    `Permanently delete ${info.email}?${history}\n\nThis cannot be undone. ` +
    `Type the email address to confirm:`);
  if (typed == null) return;
  if (typed.trim().toLowerCase() !== String(info.email).toLowerCase()) {
    alert("That didn't match — nothing was deleted.");
    return;
  }

  const r = await (await fetch(`/api/users/${id}?confirm=${encodeURIComponent(info.email)}`,
    { method: "DELETE" })).json();
  if (!r.ok) { alert(r.error || "Could not delete."); return; }
  loadUsers();
}

async function archiveUser(id, archived) {
  if (archived && !confirm("Archive this account? They lose access immediately, but their name stays on everything they recorded. You can restore them later.")) return;
  const r = await (await fetch("/api/users/" + id, { method:"PATCH",
    headers:{"Content-Type":"application/json"}, body: JSON.stringify({ archived }) })).json();
  if (!r.ok) { alert(r.error || "Could not update."); return; }
  loadUsers();
}
async function resetPw(id) {
  const pw = prompt("New temporary password for this user (min 6):"); if (!pw) return;
  const r = await (await fetch("/api/users/"+id, { method:"PATCH", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ password: pw, mustChange: true }) })).json();
  alert(r.ok ? "Password reset. Share it with the user; they'll be asked to change it." : (r.error || "Could not reset."));
  loadUsers();
}
async function toggleUser(id, disabled) {
  const r = await (await fetch("/api/users/"+id, { method:"PATCH", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ disabled }) })).json();
  if (!r.ok) alert(r.error || "Could not update.");
  loadUsers();
}
$("#showArchived")?.addEventListener("change", (e) => {
  showArchivedUsers = e.target.checked; loadUsers();
});
$("#nuRole")?.addEventListener("change", () => { $("#nuPartner").style.display = $("#nuRole").value === "partner" ? "" : "none"; });
$("#addUser")?.addEventListener("click", async () => {
  const body = { name: $("#nuName").value.trim(), email: $("#nuEmail").value.trim(), role: $("#nuRole").value,
    partner: $("#nuPartner").value, password: $("#nuPass").value };
  const r = await (await fetch("/api/users", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) })).json();
  $("#userMsg").textContent = r.ok ? `Created ${r.user.email}. Give them the temporary password.` : "Error: " + (r.error||"");
  if (r.ok) { $("#nuName").value=$("#nuEmail").value=$("#nuPass").value=""; loadUsers(); }
});

// ── upload / account menu / modals ───────────────────────
function updateUploadCurrent() {
  const p = partnersCache.find(x => x.slug === $("#uploadPartner").value);
  $("#uploadCurrent").textContent = p && p.dataset
    ? `Currently loaded: ${p.dataset.fileName || "unnamed file"} — ${p.dataset.rows.toLocaleString()} rows, uploaded ${p.dataset.uploadedAt.slice(0,10)}. Uploading now will replace it.`
    : "No file uploaded yet for this partner.";
}
async function openUpload() {
  $("#ovl").classList.add("open"); $("#modal").classList.add("open"); $("#uploadMsg").textContent="";
  const d = await (await fetch("/api/partners")).json(); partnersCache = d.partners;
  updateUploadCurrent();
}
function closeModals() { $("#ovl").classList.remove("open"); $("#modal").classList.remove("open"); $("#pwModal").classList.remove("open"); $("#invModal").classList.remove("open"); }

// Esc closes, Ctrl/Cmd+Enter saves — a data-entry screen that needs the mouse
// for every save is a slow one.
document.addEventListener("keydown", (e) => {
  const open = document.querySelector(".modal.open");
  if (!open) return;
  if (e.key === "Escape") { e.preventDefault(); closeModals(); }
  else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    open.querySelector(".btn-primary")?.click();
  }
});
$("#uploadBtn")?.addEventListener("click", openUpload);
$("#uploadPartner")?.addEventListener("change", updateUploadCurrent);
$("#doUpload")?.addEventListener("click", async () => {
  const f = $("#fileInput").files[0]; if (!f) { $("#uploadMsg").textContent = "Choose a file first."; return; }
  const fd = new FormData(); fd.append("file", f); fd.append("partner", $("#uploadPartner").value);
  $("#uploadMsg").textContent = "Uploading…";
  const r = await (await fetch("/api/upload", { method:"POST", body: fd })).json();
  if (r.ok) {
    const dated = r.meta.datesParsed != null ? `, ${r.meta.datesParsed} dated` : "";
    let msg = `Loaded "${r.meta.fileName}" — ${r.rows} rows${dated} for ${r.partner}.`;
    const warnings = r.warnings || [];
    if (warnings.length) {
      // Warnings were being computed and then thrown away. A file that loads
      // every row but no dates looked like a clean success — hold the dialog
      // open and say what is wrong instead of auto-closing over it.
      $("#uploadMsg").style.color = "var(--warning)";
      $("#uploadMsg").textContent = msg + " " + warnings.join(" ");
    } else {
      $("#uploadMsg").style.color = "";
      $("#uploadMsg").textContent = msg;
    }
    const d = await (await fetch("/api/partners")).json(); partnersCache = d.partners; updateUploadCurrent();
    if (r.partner === partnerSlug) load();
    if (!warnings.length) setTimeout(closeModals, 1600);
  }
  else {
    $("#uploadMsg").style.color = "var(--danger)";
    $("#uploadMsg").textContent = "Failed: " + (r.error || "unknown");
  }
});

$("#userBtn")?.addEventListener("click", (e) => { e.stopPropagation(); $("#userMenu").hidden = !$("#userMenu").hidden; });
document.addEventListener("click", () => { $("#userMenu").hidden = true; });
$("#userMenu")?.addEventListener("click", (e) => e.stopPropagation());
$("#miLogout")?.addEventListener("click", async () => { await fetch("/api/logout", { method:"POST" }); window.location = "/login.html"; });
$("#miChangePw")?.addEventListener("click", () => { $("#userMenu").hidden = true; $("#ovl").classList.add("open"); $("#pwModal").classList.add("open"); $("#pwMsg").textContent=""; });
$("#doChangePw")?.addEventListener("click", async () => {
  const r = await (await fetch("/api/change-password", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ current: $("#pwCurrent").value, next: $("#pwNext").value }) })).json();
  if (r.ok) { $("#pwMsg").style.color = "var(--success)"; $("#pwMsg").textContent = "Password updated."; setTimeout(closeModals, 800); }
  else { $("#pwMsg").style.color = "var(--danger)"; $("#pwMsg").textContent = r.error || "Failed."; }
});

boot();

// ── manual invoice editor (admin) ────────────────────────
// Invoices created here carry source='manual': they show to the partner
// alongside imported rows, and an Excel upload never overwrites them.
let editingInvoiceNo = null;   // null = creating a new one
let lineItems = [];

// [key, header, kind, column width]. The widths are what keep every field
// readable at once instead of collapsing into a horizontal scroll.
const LINE_COLS = [
  ["pjCode", "PJ code", "text", 108],
  ["itemCode", "Item code", "text", 108],
  ["itemType", "Type", "text", 84],
  ["supplier", "Supplier", "text", 108],
  ["weight", "Weight (g)", "num", 82],
  ["supplierPrice", "Capital", "num", 94],
  ["amount", "Item amount", "num", 104],
  ["commissionType", "Comm. type", "select", 96],
  ["commissionRate", "Rate", "num", 76],
];

function blankLine() {
  return { pjCode:"", itemCode:"", itemType:"", supplier:"", weight:"",
           supplierPrice:"", amount:"", commissionType:"JEWELRY",
           commissionRate:"0.05", commissionValue:"" };
}

// Same rules as the sheet: gold = rate x weight, jewelry = rate x selling price.
function calcCommission(it) {
  const rate = Number(it.commissionRate);
  if (!isFinite(rate) || rate === 0) return 0;
  const t = String(it.commissionType || "").toUpperCase();
  if (t === "GOLD") return Math.round(rate * (Number(it.weight) || 0) * 100) / 100;
  if (t === "JEWELRY") return Math.round(rate * (Number(it.amount) || 0) * 100) / 100;
  return 0;
}
const lineCommission = (it) =>
  it.commissionValue !== "" && it.commissionValue != null
    ? Number(it.commissionValue) : calcCommission(it);

function renderLines() {
  const cols = `<colgroup><col style="width:30px">${
    LINE_COLS.map(c => `<col style="width:${c[3]}px">`).join("")
  }<col style="width:106px"><col style="width:30px"></colgroup>`;

  const head = `<thead><tr><th></th>${
    LINE_COLS.map(c => `<th class="${c[2]==="num"?"num":""}">${c[1]}</th>`).join("")
  }<th class="num">Commission</th><th></th></tr></thead>`;

  const PH = { pjCode: "PJ0000", itemCode: "code", itemType: "e.g. RING",
               supplier: "supplier", weight: "0.00", supplierPrice: "0.00",
               amount: "0.00", commissionRate: "0.05" };

  const body = lineItems.map((it, i) => `<tr>
    <td class="rownum">${i + 1}</td>
    ${LINE_COLS.map(([k, , kind]) => {
      if (kind === "select") {
        return `<td><select data-i="${i}" data-k="${k}">
          <option value="JEWELRY" ${it[k]==="JEWELRY"?"selected":""}>Jewelry</option>
          <option value="GOLD" ${it[k]==="GOLD"?"selected":""}>Gold</option>
        </select></td>`;
      }
      return `<td class="${kind==="num"?"num":""}"><input data-i="${i}" data-k="${k}"
        type="${kind==="num"?"number":"text"}" step="any" value="${escA(it[k])}"
        placeholder="${PH[k] || ""}"></td>`;
    }).join("")}
    <td class="num calc-cell"><input data-i="${i}" data-k="commissionValue" type="number" step="any"
        title="Calculated automatically — type here only to override it"
        placeholder="${lineCommission(it).toFixed(2)}" value="${escA(it.commissionValue)}"></td>
    <td><span class="lnk-del" onclick="removeLine(${i})" title="Remove line">×</span></td>
  </tr>`).join("");

  $("#invItems").innerHTML = cols + head + `<tbody>${body}</tbody>`;
  $("#invItems").querySelectorAll("input,select").forEach(el =>
    el.addEventListener("input", () => {
      lineItems[+el.dataset.i][el.dataset.k] = el.value;
      renderTotals();
      // Re-render only when the commission basis changed, so typing isn't interrupted.
      if (["commissionType","commissionRate","weight","amount"].includes(el.dataset.k)) {
        const active = document.activeElement;
        const i = active && active.dataset ? active.dataset.i : null;
        const k = active && active.dataset ? active.dataset.k : null;
        renderLines();
        if (i != null) {
          const back = $(`#invItems [data-i="${i}"][data-k="${k}"]`);
          if (back) { back.focus(); if (back.setSelectionRange && back.type==="text") back.setSelectionRange(9999,9999); }
        }
      }
    }));
  renderTotals();
}

function renderTotals() {
  const amount = lineItems.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  const comm   = lineItems.reduce((s, it) => s + lineCommission(it), 0);
  const weight = lineItems.reduce((s, it) => s + (Number(it.weight) || 0), 0);
  $("#invTotals").innerHTML =
    `<span>${lineItems.length} line${lineItems.length===1?"":"s"}</span>` +
    `<span>Weight <b>${grams(weight)}</b></span>` +
    `<span class="tot-spacer"></span>` +
    `<span>Item amount <b>${money(amount)}</b></span>` +
    `<span class="tot-comm">Commission <b>${money(comm)}</b></span>`;
}

function removeLine(i) { lineItems.splice(i, 1); if (!lineItems.length) lineItems.push(blankLine()); renderLines(); }

function openInvoiceEditor(existing) {
  editingInvoiceNo = existing ? existing.invoice : null;
  $("#invModalTitle").textContent = existing ? "Edit invoice " + existing.invoice : "New invoice";
  $("#btnDeleteInvoice").hidden = !existing;
  $("#invMsg").textContent = "";
  $("#invNo").value = existing ? existing.invoice : "";
  $("#invClient").value = existing ? existing.client : "";
  $("#invDate").value    = existing ? existing.date : new Date().toISOString().slice(0, 10);
  // Suggest clients we already have, so the same person isn't typed three
  // different ways and split across three rows in the By-client report.
  const known = (CURRENT && CURRENT.filterOptions ? CURRENT.filterOptions.clients : []) || [];
  $("#clientList").innerHTML = known.map(c => `<option value="${escA(c)}">`).join("");
  lineItems = existing && existing.items.length
    ? existing.items.map(it => ({ ...it,
        commissionValue: "",                      // blank = use the calculated value
        commissionRate: it.commissionRate ?? "" }))
    : [blankLine()];
  renderLines();
  $("#ovl").classList.add("open"); $("#invModal").classList.add("open");
  $("#invModal .modal-body").scrollTop = 0;
  setTimeout(() => (existing ? $("#invItems input") : $("#invNo"))?.focus(), 30);
}

$("#btnAddLine")?.addEventListener("click", () => {
  lineItems.push(blankLine()); renderLines();
  const wrap = $(".inv-items-wrap"); if (wrap) wrap.scrollTop = wrap.scrollHeight;
  $(`#invItems [data-i="${lineItems.length - 1}"]`)?.focus();
});

// Most invoices are several near-identical lines; copying the last one beats
// retyping the supplier and rate every time.
$("#btnDupLine")?.addEventListener("click", () => {
  const last = lineItems[lineItems.length - 1];
  lineItems.push(last ? { ...last, commissionValue: "" } : blankLine());
  renderLines();
  const wrap = $(".inv-items-wrap"); if (wrap) wrap.scrollTop = wrap.scrollHeight;
});
$("#btnNewInvoice")?.addEventListener("click", () => openInvoiceEditor(null));

$("#btnSaveInvoice")?.addEventListener("click", async () => {
  const payload = {
    partner: partnerSlug,
    invoice: $("#invNo").value.trim(),
    client: $("#invClient").value.trim(),
    date: $("#invDate").value,
    items: lineItems,
  };
  if (editingInvoiceNo) payload.originalInvoice = editingInvoiceNo;

  $("#invMsg").style.color = "var(--muted)";
  $("#invMsg").textContent = "Saving…";
  const r = await (await fetch("/api/manual-invoice", {
    method: editingInvoiceNo ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })).json();

  if (r.ok) {
    closeModals();
    await loadInvoices();
    await load();                       // refresh KPIs/report too
    openInvoice(r.invoice);
  } else {
    $("#invMsg").style.color = "var(--danger)";
    $("#invMsg").textContent = r.error || "Could not save.";
  }
});

$("#btnDeleteInvoice")?.addEventListener("click", async () => {
  if (!editingInvoiceNo) return;
  if (!confirm(`Delete invoice ${editingInvoiceNo}? This cannot be undone.`)) return;
  const qs = new URLSearchParams({ partner: partnerSlug, invoice: editingInvoiceNo });
  const r = await (await fetch("/api/manual-invoice?" + qs, { method: "DELETE" })).json();
  if (r.ok) {
    closeModals();
    $("#invDetail").innerHTML = `<div class="empty-state"><div class="empty-text">Invoice deleted.</div></div>`;
    await loadInvoices(); await load();
  } else alert("Could not delete: " + (r.error || "unknown"));
});

/** Load a manual invoice into the editor (called from the detail view). */
async function editInvoice(no) {
  const qs = new URLSearchParams({ partner: partnerSlug, invoice: no });
  const d = await (await fetch("/api/manual-invoice?" + qs)).json();
  if (d.error) { alert(d.error); return; }
  openInvoiceEditor(d);
}

// ── commission payouts (statement of account) ────────────
// A running account, not per-invoice: earned − paid = balance payable.
// Owner + admin record payments; the partner sees it read-only.
async function loadPayments() {
  const qs = new URLSearchParams(); if (partnerSlug) qs.set("partner", partnerSlug);
  const r = await fetch("/api/payments?" + qs);
  if (r.status === 403) {
    $("#payKpis").innerHTML = "";
    $("#tblPayments").innerHTML = "";
    $("#payFormCard").hidden = true;
    return;
  }
  const d = await r.json();
  if (!d.summary) { $("#payKpis").innerHTML = `<div class="page-sub">No partner selected.</div>`; return; }

  const s = d.summary;
  const owing = s.balance > 0.005;
  $("#payKpis").innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Commission earned</div>
      <div class="kpi-value">${money(s.earned)}</div>
      <div class="kpi-sub">total, all time</div></div>
    <div class="kpi-card"><div class="kpi-label">Total paid</div>
      <div class="kpi-value teal">${money(s.paid)}</div>
      <div class="kpi-sub">${d.payments.length} payment${d.payments.length===1?"":"s"}</div></div>
    <div class="kpi-card"><div class="kpi-label">Balance payable</div>
      <div class="kpi-value ${owing ? "balance-due" : "balance-clear"}">${money(s.balance)}</div>
      <div class="kpi-sub">${esc(s.status)}</div></div>`;

  $("#ncPayments").textContent = d.payments.length || "";
  $("#payFormCard").hidden = !d.canRecord;
  if (d.canRecord && !$("#payDate").value) $("#payDate").value = new Date().toISOString().slice(0,10);

  const cols = [["paid_on","Date"],["amount","Amount","num"],["method","Method"],
                ["reference","Reference"],["note","Note"],["created_by","Recorded by"],
                ["proof","Proof"],["act","",""]];
  const head = `<thead><tr>${cols.map(c=>`<th class="${c[2]==='num'?'num':''}">${c[1]}</th>`).join("")}</tr></thead>`;
  const body = d.payments.map(p => `<tr>
      <td>${String(p.paid_on).slice(0,10)}</td>
      <td class="num">${money(p.amount)}</td>
      <td>${disp(p.method)}</td>
      <td>${disp(p.reference)}</td>
      <td>${disp(p.note)}</td>
      <td class="page-sub">${disp(p.created_by)}</td>
      <td>${p.has_proof ? `<a href="/api/payment-proof?id=${p.id}" target="_blank">view</a>` : "N/A"}</td>
      <td>${d.canRecord ? `<span class="lnk-del" title="Delete payment" onclick="deletePayment(${p.id})">×</span>` : ""}</td>
    </tr>`).join("");
  $("#tblPayments").innerHTML = head + `<tbody>${body}</tbody>` +
    (d.payments.length ? "" : `<tbody><tr><td colspan="8" class="page-sub" style="padding:14px;">No payments recorded yet.</td></tr></tbody>`);
}

$("#btnAddPayment")?.addEventListener("click", async () => {
  const fd = new FormData();
  fd.append("partner", partnerSlug);
  fd.append("amount", $("#payAmount").value);
  fd.append("paidOn", $("#payDate").value);
  fd.append("method", $("#payMethod").value);
  fd.append("reference", $("#payRef").value);
  fd.append("note", $("#payNote").value);
  const f = $("#payProof").files[0]; if (f) fd.append("file", f);

  $("#payMsg").style.color = "var(--muted)";
  $("#payMsg").textContent = "Saving…";
  const r = await (await fetch("/api/payments", { method: "POST", body: fd })).json();
  if (r.ok) {
    $("#payAmount").value = ""; $("#payRef").value = ""; $("#payNote").value = "";
    $("#payProof").value = "";
    $("#payMsg").style.color = "var(--success)";
    $("#payMsg").textContent = `Recorded. Balance now ${money(r.summary.balance)}.`;
    loadPayments(); load();
  } else {
    $("#payMsg").style.color = "var(--danger)";
    $("#payMsg").textContent = r.error || "Could not save.";
  }
});

async function deletePayment(id) {
  if (!confirm("Delete this payment? The balance will go back up.")) return;
  const r = await (await fetch("/api/payments/" + id, { method: "DELETE" })).json();
  if (r.ok) { loadPayments(); load(); }
  else alert("Could not delete: " + (r.error || "unknown"));
}
