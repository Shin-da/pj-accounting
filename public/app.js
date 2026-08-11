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
  load();
  if (document.querySelector("#page-invoices.active")) loadInvoices();
}

const esc = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const money = (n) => CUR + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const grams = (n) => (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }) + " g";
// commission rate: 0.05 -> "5%", 50 -> "₱50/g"
const fmtRate = (v) => { const n = parseFloat(v); if (isNaN(n)) return "N/A"; return n > 0 && n < 1 ? (+(n*100).toFixed(2)) + "%" : "₱" + n + "/g"; };
// display helper: blanks / dashes / em-dashes / N-A placeholders -> "N/A"
const BLANKISH = new Set(["", "-", "—", "–", "N/A", "NA", "n/a"]);
const disp = (v) => { const s = String(v ?? "").trim(); return BLANKISH.has(s) ? "N/A" : esc(s); };
const cssVar = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const ACCENT = "#4f46e5", TEAL = "#0d9488";
const PIE = ["#4f46e5","#0d9488","#d97706","#16a34a","#dc2626","#7c3aed","#0891b2","#db2777"];

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
  if (me.partners[0]) $("#brandSub").textContent = me.partners.find(p=>p.slug===partnerSlug)?.name || "";
  sw.value = partnerSlug;
  sw.addEventListener("change", () => { partnerSlug = sw.value; $("#brandSub").textContent = me.partners.find(p=>p.slug===partnerSlug)?.name||""; renderBrandMark(); filters.client = ""; $("#fClient").value = ""; refreshAll(); });
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

// Header mark: the selected partner's logo, or their initials as a fallback.
function initialsOf(name) {
  return String(name || "").split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0]).join("").toUpperCase() || "•";
}
function renderBrandMark() {
  const p = (ME.partners || []).find(x => x.slug === partnerSlug);
  const mark = $("#brandMark");
  $("#brandInitials").textContent = initialsOf(p && p.name);
  const old = mark.querySelector("img"); if (old) old.remove();
  mark.classList.remove("has-img");
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
  $("#updatedFoot").textContent = data.meta
    ? (data.meta.fileName ? data.meta.fileName + " · " : "") + "Updated " + data.meta.uploadedAt.slice(0,10)
    : "—";
  $("#ncRows").textContent = data.rowsTotal.toLocaleString();
  $("#ncClients").textContent = data.clients.length;
  $("#ncTypes").textContent = data.types.length;
  // (Re)populate the client filter from the unfiltered dataset, keeping selection.
  if (data.filterOptions) {
    const sel = $("#fClient"), cur = filters.client;
    sel.innerHTML = `<option value="">All clients</option>` +
      data.filterOptions.clients.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
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
  $("#kpis").innerHTML = cards.map(c => `<div class="kpi-card"><div class="kpi-label">${c.label}</div><div class="kpi-value ${c.cls}">${c.value}</div><div class="kpi-sub">${c.sub}</div></div>`).join("");
}

function mk(id, cfg) { if (charts[id]) charts[id].destroy(); charts[id] = new Chart($("#"+id), cfg); }
function renderCharts() {
  const tick = cssVar("--muted") || "#78716c", grid = cssVar("--border") || "rgba(0,0,0,.06)";
  const tt = $("#typeChartTitle"); if (tt) tt.textContent = "Sales by " + typeLabel();
  const hasComm = CURRENT.kpi.commissionValue !== undefined;
  const m = CURRENT.months;
  const ds = [{ label: "Sales", data: m.map(x=>x.amount), borderColor: ACCENT, backgroundColor: "rgba(79,70,229,.12)", fill: true, tension: .35, borderWidth: 2, pointRadius: 2, yAxisID: "y" }];
  if (hasComm) ds.push({ label: "Commission", data: m.map(x=>x.commissionValue||0), borderColor: TEAL, backgroundColor: "rgba(13,148,136,.10)", fill: true, tension: .35, borderWidth: 2, pointRadius: 2, yAxisID: "y1" });
  mk("chTime", { type: "line", data: { labels: m.map(x=>x.month), datasets: ds },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: cssVar("--muted2") } } },
      scales: { x: { ticks:{color:tick}, grid:{color:grid} },
        y: { position:"left", ticks:{color:tick, callback:v=>CUR+(v/1000)+"k"}, grid:{color:grid} },
        y1: { position:"right", display: hasComm, ticks:{color:tick, callback:v=>CUR+(v/1000)+"k"}, grid:{drawOnChartArea:false} } } } });

  const types = CURRENT.types.slice(0,8);
  mk("chType", { type: "doughnut", data: { labels: types.map(t=>t.itemType), datasets: [{ data: types.map(t=>t.amount), backgroundColor: PIE, borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: "62%", plugins: { legend: { position: "right", labels: { color: cssVar("--muted2"), boxWidth: 12, font:{size:11} } } } } });

  const cl = CURRENT.clients.slice(0,10);
  mk("chClient", { type: "bar", data: { labels: cl.map(c=>c.client), datasets: [{ data: cl.map(c=>c.amount), backgroundColor: ACCENT, borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, indexAxis: "y", plugins: { legend: { display: false } }, scales: { x:{ticks:{color:tick},grid:{color:grid}}, y:{ticks:{color:tick,font:{size:11}},grid:{display:false}} } } });

  $("#commCard").hidden = !hasComm;
  if (hasComm) {
    const cc = [...CURRENT.clients].sort((a,b)=>(b.commissionValue||0)-(a.commissionValue||0)).slice(0,10);
    mk("chComm", { type: "bar", data: { labels: cc.map(c=>c.client), datasets: [{ data: cc.map(c=>c.commissionValue||0), backgroundColor: TEAL, borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, indexAxis: "y", plugins: { legend: { display: false } }, scales: { x:{ticks:{color:tick},grid:{color:grid}}, y:{ticks:{color:tick,font:{size:11}},grid:{display:false}} } } });
  }
}

// ── tables (columns adapt to what the API returned) ──────
// Sortable: click a header to sort asc, again for desc. "__n" renders the
// 1-based row number (of the sorted view) and isn't sortable.
const SORT = {};        // el -> { key, dir }
const TABLE_ARGS = {};  // el -> args, so a header click can re-render
function smartCompare(av, bv) {
  const an = typeof av === "number", bn = typeof bv === "number";
  if (an || bn) return (av || 0) - (bv || 0);
  const af = parseFloat(av), bf = parseFloat(bv);
  if (!isNaN(af) && !isNaN(bf)) return af - bf;
  return String(av ?? "").localeCompare(String(bv ?? ""));
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
  if ("supplier" in r0) regCols.push(["supplier","Supplier"]);
  if ("commissionType" in r0) regCols.push(["commissionType","Comm. type"]);
  regCols.push(["weight","Weight","num"]);
  if ("supplierPrice" in r0) regCols.push(["supplierPrice","Capital","num"]);
  if ("capitalPerGram" in r0) regCols.push(["capitalPerGram","₱/g","num"]);
  regCols.push(["amount","Item amount","num"]);
  if ("commissionRate" in r0) regCols.push(["commissionRate","Comm. rate"]);
  if ("commissionValue" in r0) regCols.push(["commissionValue","Commission amount","num"]);

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

  table("#tblRegister", regCols, CURRENT.rows, (r,k,kind) => kind==="num" ? (k==="weight" ? (r[k]?grams(r[k]):"N/A") : (r[k]?money(r[k]):"N/A")) : (k==="commissionRate" ? fmtRate(r[k]) : disp(r[k])), foot);

  const c0 = CURRENT.clients[0] || {};
  const clientCols = [["client","Client"],["invoices","Invoices","num"],["amount","Sales","num"]];
  if ("commissionValue" in c0) clientCols.push(["commissionValue","Commission","num"]);
  if ("cost" in c0) clientCols.push(["cost","Cost","num"]);
  if ("margin" in c0) clientCols.push(["margin","Margin","num"]);
  table("#tblClients", clientCols, CURRENT.clients, (r,k,kind) => kind==="num" ? (k==="invoices"?r[k]:money(r[k])) : esc(r[k]));

  const t0 = CURRENT.types[0] || {};
  const typeCols = [["itemType", isCommDim() ? "Commission type" : "Item type"],["count","Items","num"],["weight","Weight","num"],["amount","Sales","num"]];
  if ("commissionValue" in t0) typeCols.push(["commissionValue","Commission","num"]);
  table("#tblTypes", typeCols, CURRENT.types, (r,k,kind) => kind==="num" ? (k==="count"?r[k]:k==="weight"?grams(r[k]):money(r[k])) : esc(r[k]));
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
  if (!d.invoices || !d.invoices.length) { $("#invList").innerHTML = `<div class="page-sub" style="padding:16px;">No invoices for this partner.</div>`; return; }
  $("#invList").innerHTML = d.invoices.map(inv => `
    <div class="inv-row" data-reserve="${esc(inv.reserve)}" onclick="openInvoice('${inv.reserve.replace(/'/g,"\\'")}')">
      <div class="inv-row-top"><span class="inv-res">${esc(inv.reserve)}</span>${
        inv.source === "manual" ? '<span class="pill-manual" title="created in this system">manual</span>' : ''
      }${inv.hasProof ? '<span class="inv-clip" title="has proof">📎</span>' : ''}</div>
      <div class="inv-row-sub">${esc(inv.clients.join(", ")) || "N/A"}</div>
      <div class="inv-row-meta"><span>${inv.date || "N/A"}</span><span>${inv.count} item${inv.count>1?"s":""}</span><span class="mono">${money(inv.amount)}</span></div>
    </div>`).join("");
}

async function openInvoice(reserve) {
  document.querySelectorAll(".inv-row").forEach(r => r.classList.toggle("active", r.dataset.reserve === reserve));
  const qs = new URLSearchParams(); if (partnerSlug) qs.set("partner", partnerSlug); qs.set("reserve", reserve);
  const d = await (await fetch("/api/invoice?" + qs)).json();
  if (d.error) { $("#invDetail").innerHTML = `<div class="empty-state"><div class="empty-text">${esc(d.error)}</div></div>`; return; }
  currentInvoice = d;
  const t = d.totals, i0 = d.items[0] || {};

  const cols = [["pjCode","PJ code"],["itemCode","Item code"],["itemType","Type"]];
  if ("supplier" in i0) cols.push(["supplier","Supplier"]);
  if ("commissionType" in i0) cols.push(["commissionType","Comm. type"]);
  cols.push(["weight","Weight","num"]);
  if ("supplierPrice" in i0) cols.push(["supplierPrice","Capital","num"]);
  cols.push(["amount","Item amount","num"]);
  if ("commissionRate" in i0) cols.push(["commissionRate","Comm. rate"]);
  if ("commissionValue" in i0) cols.push(["commissionValue","Commission amount","num"]);
  cols.unshift(["__n","#"]);
  const cell = (it,k,kind) => kind==="num" ? (k==="weight" ? (it[k]?grams(it[k]):"N/A") : (it[k]?money(it[k]):"N/A")) : (k==="commissionRate" ? fmtRate(it[k]) : disp(it[k]));
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
      <div class="inv-headmeta">${d.date || "N/A"} · ${esc(d.clients.join(", ")) || "N/A"} · ${t.count} item${t.count>1?"s":""}</div>
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
      { label: "Sales", data: d.partners.map(p=>p.amount), backgroundColor: ACCENT, borderRadius: 4 },
      { label: "ONELIVE profit", data: d.partners.map(p=>p.onelive), backgroundColor: TEAL, borderRadius: 4 } ] },
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
async function loadUsers() {
  const d = await (await fetch("/api/users")).json();
  const cols = [["name","Name"],["email","Email"],["role","Role"],["partner","Partner"],["status","Status"],["act","",""]];
  const body = d.users.map(u => `<tr>
    <td>${esc(u.name)}</td><td class="mono">${esc(u.email)}</td><td>${u.role}</td><td>${esc(u.partner||"—")}</td>
    <td>${u.disabled?'<span class="status-pill sp-inactive">disabled</span>':'<span class="status-pill sp-active">active</span>'}${u.mustChange?' <span class="page-sub">(temp pw)</span>':''}</td>
    <td><button class="btn btn-ghost btn-sm" onclick="resetPw('${u.id}')">Reset pw</button> <button class="btn btn-ghost btn-sm" onclick="toggleUser('${u.id}',${u.disabled?false:true})">${u.disabled?"Enable":"Disable"}</button></td>
  </tr>`).join("");
  $("#tblUsers").innerHTML = `<thead><tr>${cols.map(c=>`<th>${c[1]}</th>`).join("")}</tr></thead><tbody>${body}</tbody>`;
}
async function resetPw(id) {
  const pw = prompt("New temporary password for this user (min 6):"); if (!pw) return;
  await fetch("/api/users/"+id, { method:"PATCH", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ password: pw, mustChange: true }) });
  alert("Password reset. Share it with the user; they'll be asked to change it."); loadUsers();
}
async function toggleUser(id, disabled) { await fetch("/api/users/"+id, { method:"PATCH", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ disabled }) }); loadUsers(); }
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
$("#uploadBtn")?.addEventListener("click", openUpload);
$("#uploadPartner")?.addEventListener("change", updateUploadCurrent);
$("#doUpload")?.addEventListener("click", async () => {
  const f = $("#fileInput").files[0]; if (!f) { $("#uploadMsg").textContent = "Choose a file first."; return; }
  const fd = new FormData(); fd.append("file", f); fd.append("partner", $("#uploadPartner").value);
  $("#uploadMsg").textContent = "Uploading…";
  const r = await (await fetch("/api/upload", { method:"POST", body: fd })).json();
  if (r.ok) {
    $("#uploadMsg").textContent = `Loaded "${r.meta.fileName}" — ${r.meta.rows} rows for ${r.partner}. Saved to ${r.path}.`;
    const d = await (await fetch("/api/partners")).json(); partnersCache = d.partners; updateUploadCurrent();
    setTimeout(()=>{ closeModals(); if (r.partner===partnerSlug) load(); }, 1600);
  }
  else $("#uploadMsg").textContent = "Failed: " + (r.error || "unknown");
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

const LINE_COLS = [
  ["pjCode", "PJ code", "text"],
  ["itemCode", "Item code", "text"],
  ["itemType", "Type", "text"],
  ["supplier", "Supplier", "text"],
  ["weight", "Weight (g)", "num"],
  ["supplierPrice", "Capital", "num"],
  ["amount", "Item amount", "num"],
  ["commissionType", "Comm. type", "select"],
  ["commissionRate", "Rate", "num"],
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
  const head = `<thead><tr><th style="width:26px"></th>${
    LINE_COLS.map(c => `<th class="${c[2]==="num"?"num":""}">${c[1]}</th>`).join("")
  }<th class="num">Commission</th><th style="width:26px"></th></tr></thead>`;

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
        type="${kind==="num"?"number":"text"}" step="any" value="${esc(it[k])}"></td>`;
    }).join("")}
    <td class="num"><input data-i="${i}" data-k="commissionValue" type="number" step="any"
        placeholder="${lineCommission(it).toFixed(2)}" value="${esc(it.commissionValue)}"></td>
    <td><span class="lnk-del" onclick="removeLine(${i})" title="Remove line">×</span></td>
  </tr>`).join("");

  $("#fItems").innerHTML = head + `<tbody>${body}</tbody>`;
  $("#fItems").querySelectorAll("input,select").forEach(el =>
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
          const back = $(`#fItems [data-i="${i}"][data-k="${k}"]`);
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
  $("#fTotals").innerHTML =
    `<span>${lineItems.length} line${lineItems.length===1?"":"s"}</span>` +
    `<span>Weight <b>${grams(weight)}</b></span>` +
    `<span>Item amount <b>${money(amount)}</b></span>` +
    `<span>Commission <b>${money(comm)}</b></span>`;
}

function removeLine(i) { lineItems.splice(i, 1); if (!lineItems.length) lineItems.push(blankLine()); renderLines(); }

function openInvoiceEditor(existing) {
  editingInvoiceNo = existing ? existing.invoice : null;
  $("#invModalTitle").textContent = existing ? "Edit invoice " + existing.invoice : "New invoice";
  $("#btnDeleteInvoice").hidden = !existing;
  $("#invMsg").textContent = "";
  $("#fInvoice").value = existing ? existing.invoice : "";
  $("#fClient").value  = existing ? existing.client : "";
  $("#fDate").value    = existing ? existing.date : new Date().toISOString().slice(0, 10);
  lineItems = existing && existing.items.length
    ? existing.items.map(it => ({ ...it,
        commissionValue: "",                      // blank = use the calculated value
        commissionRate: it.commissionRate ?? "" }))
    : [blankLine()];
  renderLines();
  $("#ovl").classList.add("open"); $("#invModal").classList.add("open");
}

$("#btnAddLine")?.addEventListener("click", () => { lineItems.push(blankLine()); renderLines(); });
$("#btnNewInvoice")?.addEventListener("click", () => openInvoiceEditor(null));

$("#btnSaveInvoice")?.addEventListener("click", async () => {
  const payload = {
    partner: partnerSlug,
    invoice: $("#fInvoice").value.trim(),
    client: $("#fClient").value.trim(),
    date: $("#fDate").value,
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
