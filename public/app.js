const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
let CUR = "₱", ME = null, period = "all", CURRENT = null, partnerSlug = "";
const charts = {};

const esc = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const money = (n) => CUR + Math.round(n || 0).toLocaleString();
const grams = (n) => (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }) + " g";
const cssVar = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const ACCENT = "#4f46e5", TEAL = "#0d9488";
const PIE = ["#4f46e5","#0d9488","#d97706","#16a34a","#dc2626","#7c3aed","#0891b2","#db2777"];

// ── theme ────────────────────────────────────────────────
function applyTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem("rdr-theme", t); } catch(_){} if (CURRENT) renderCharts(); }
$("#themeToggle").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
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
  $("#adminNav").hidden = !isOwnerOrAdmin;
  $$("[data-admin]").forEach(el => el.hidden = !isAdmin);

  // partner switcher (admin/owner). Partners see only their own — no switcher.
  const sw = $("#partnerSwitch");
  sw.innerHTML = me.partners.map(p => `<option value="${p.slug}">${esc(p.name)}</option>`).join("");
  partnerSlug = me.partners[0] ? me.partners[0].slug : "";
  $("#partnerSwitchWrap").hidden = me.user.role === "partner" || me.partners.length <= 1;
  if (me.partners[0]) $("#brandSub").textContent = me.partners.find(p=>p.slug===partnerSlug)?.name || "";
  sw.value = partnerSlug;
  sw.addEventListener("change", () => { partnerSlug = sw.value; $("#brandSub").textContent = me.partners.find(p=>p.slug===partnerSlug)?.name||""; load(); });

  if (isAdmin) { fillPartnerSelect("#uploadPartner"); fillPartnerSelect("#nuPartner"); }
  load();
}

const isCommDim = () => CURRENT && CURRENT.typeDimension === "commission";
const typeLabel = () => (isCommDim() ? "commission type" : "item type");

function fillPartnerSelect(sel) {
  $(sel).innerHTML = ME.partners.map(p => `<option value="${p.slug}">${esc(p.name)}</option>`).join("");
}

// ── nav ──────────────────────────────────────────────────
$$(".nav-item").forEach(b => b.addEventListener("click", () => {
  $$(".nav-item").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  $$(".page").forEach(p => p.classList.remove("active"));
  $("#page-" + b.dataset.page).classList.add("active");
  const rep = ["overview","register","clients","types"].includes(b.dataset.page);
  $("#filterBar").hidden = !rep || !CURRENT;
  if (b.dataset.page === "portfolio") loadPortfolio();
  if (b.dataset.page === "partners") loadPartners();
  if (b.dataset.page === "users") loadUsers();
  if (b.dataset.page === "invoices") loadInvoices();
}));

// ── period ───────────────────────────────────────────────
$("#periodSeg").addEventListener("click", (e) => {
  const b = e.target.closest(".seg-btn"); if (!b) return;
  $$(".seg-btn").forEach(x => x.classList.remove("active")); b.classList.add("active");
  period = b.dataset.p; $("#customRange").hidden = period !== "custom";
  if (period !== "custom") load();
});
$("#from").addEventListener("change", load);
$("#to").addEventListener("change", load);
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
  const { from, to } = periodRange();
  const qs = new URLSearchParams(); if (partnerSlug) qs.set("partner", partnerSlug);
  if (from) qs.set("from", from); if (to) qs.set("to", to);
  const data = await (await fetch("/api/report?" + qs.toString())).json();
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
function table(el, cols, rows, cellFn) {
  const head = `<thead><tr>${cols.map(c => `<th class="${c[2]==='num'?'num':''}">${c[1]}</th>`).join("")}</tr></thead>`;
  const body = `<tbody>${rows.map(r => `<tr>${cols.map(c => `<td class="${c[2]==='num'?'num':''}">${cellFn(r,c[0],c[2])}</td>`).join("")}</tr>`).join("")}</tbody>`;
  $(el).innerHTML = head + body;
}
function renderTables() {
  const r0 = CURRENT.rows[0] || {};
  const regCols = [["date","Date"],["invoice","Reserve #"],["client","Client"],["supplier","Supplier"]];
  if ("supplierPrice" in r0) regCols.push(["supplierPrice","Capital","num"]);
  if ("capitalPerGram" in r0) regCols.push(["capitalPerGram","₱/g","num"]);
  regCols.push(["weight","Weight","num"], ["amount","Selling price","num"]);
  if ("commissionValue" in r0) regCols.push(["commissionValue","Commission","num"]);
  table("#tblRegister", regCols, CURRENT.rows, (r,k,kind) => kind==="num" ? (k==="weight" ? (r[k]?grams(r[k]):"—") : (r[k]?money(r[k]):"—")) : esc(r[k]));

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
  const qs = new URLSearchParams(); if (partnerSlug) qs.set("partner", partnerSlug);
  const d = await (await fetch("/api/invoices?" + qs)).json();
  $("#ncInvoices").textContent = (d.invoices || []).length;
  if (!d.invoices || !d.invoices.length) { $("#invList").innerHTML = `<div class="page-sub" style="padding:16px;">No invoices for this partner.</div>`; return; }
  $("#invList").innerHTML = d.invoices.map(inv => `
    <div class="inv-row" data-reserve="${esc(inv.reserve)}" onclick="openInvoice('${inv.reserve.replace(/'/g,"\\'")}')">
      <div class="inv-row-top"><span class="inv-res">${esc(inv.reserve)}</span>${inv.hasProof ? '<span class="inv-clip" title="has proof">📎</span>' : ''}</div>
      <div class="inv-row-sub">${esc(inv.clients.join(", ")) || "—"}</div>
      <div class="inv-row-meta"><span>${inv.date || "—"}</span><span>${inv.count} item${inv.count>1?"s":""}</span><span class="mono">${money(inv.amount)}</span></div>
    </div>`).join("");
}

async function openInvoice(reserve) {
  document.querySelectorAll(".inv-row").forEach(r => r.classList.toggle("active", r.dataset.reserve === reserve));
  const qs = new URLSearchParams(); if (partnerSlug) qs.set("partner", partnerSlug); qs.set("reserve", reserve);
  const d = await (await fetch("/api/invoice?" + qs)).json();
  if (d.error) { $("#invDetail").innerHTML = `<div class="empty-state"><div class="empty-text">${esc(d.error)}</div></div>`; return; }
  currentInvoice = d;
  const t = d.totals, i0 = d.items[0] || {};

  const cols = [["pjCode","PJ code"],["itemCode","Item code"],["supplier","Supplier"],["itemType","Type"],["weight","Weight","num"]];
  if ("supplierPrice" in i0) cols.push(["supplierPrice","Capital","num"]);
  cols.push(["amount","Selling","num"]);
  if ("commissionValue" in i0) cols.push(["commissionValue","Commission","num"]);
  const cell = (it,k,kind) => kind==="num" ? (k==="weight" ? (it[k]?grams(it[k]):"—") : (it[k]?money(it[k]):"—")) : esc(it[k]||"—");
  const head = `<thead><tr>${cols.map(c=>`<th class="${c[2]==='num'?'num':''}">${c[1]}</th>`).join("")}</tr></thead>`;
  const body = `<tbody>${d.items.map(it=>`<tr>${cols.map(c=>`<td class="${c[2]==='num'?'num':''}">${cell(it,c[0],c[2])}</td>`).join("")}</tr>`).join("")}</tbody>`;

  const chips = [`<div class="inv-tot"><div class="kpi-label">Selling</div><div class="inv-tot-v">${money(t.amount)}</div></div>`];
  if (t.commissionValue !== undefined) chips.push(`<div class="inv-tot"><div class="kpi-label">Commission</div><div class="inv-tot-v accent">${money(t.commissionValue)}</div></div>`);
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
      <div class="inv-eyebrow">Reserve no.</div>
      <div class="inv-reserve">${esc(d.reserve)}</div>
      <div class="inv-headmeta">${d.date || "—"} · ${esc(d.clients.join(", ")) || "—"} · ${t.count} item${t.count>1?"s":""}</div>
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
    return `<div class="partner-row"><div class="pr-name">${esc(p.name)} <span class="page-sub">/${p.slug}</span></div>
      ${fileInfo}
      <div class="page-sub" style="margin:8px 0 6px;">What this partner may see:</div>
      <div class="flag-toggles">${cb("commission","Their commission")}${cb("cost","Supplier cost")}${cb("margin","Gross margin")}${cb("onelive","ONELIVE profit")}</div></div>`;
  }).join("") || `<div class="page-sub">No partners yet.</div>`;
  $$("#partnersList input[type=checkbox]").forEach(cb => cb.addEventListener("change", async () => {
    const flags = {}; flags[cb.dataset.flag] = cb.checked;
    await fetch("/api/partners/" + cb.dataset.slug, { method:"PATCH", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ flags }) });
  }));
}
$("#addPartner").addEventListener("click", async () => {
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
$("#nuRole").addEventListener("change", () => { $("#nuPartner").style.display = $("#nuRole").value === "partner" ? "" : "none"; });
$("#addUser").addEventListener("click", async () => {
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
function closeModals() { $("#ovl").classList.remove("open"); $("#modal").classList.remove("open"); $("#pwModal").classList.remove("open"); }
$("#uploadBtn").addEventListener("click", openUpload);
$("#uploadPartner").addEventListener("change", updateUploadCurrent);
$("#doUpload").addEventListener("click", async () => {
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

$("#userBtn").addEventListener("click", (e) => { e.stopPropagation(); $("#userMenu").hidden = !$("#userMenu").hidden; });
document.addEventListener("click", () => { $("#userMenu").hidden = true; });
$("#userMenu").addEventListener("click", (e) => e.stopPropagation());
$("#miLogout").addEventListener("click", async () => { await fetch("/api/logout", { method:"POST" }); window.location = "/login.html"; });
$("#miChangePw").addEventListener("click", () => { $("#userMenu").hidden = true; $("#ovl").classList.add("open"); $("#pwModal").classList.add("open"); $("#pwMsg").textContent=""; });
$("#doChangePw").addEventListener("click", async () => {
  const r = await (await fetch("/api/change-password", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ current: $("#pwCurrent").value, next: $("#pwNext").value }) })).json();
  if (r.ok) { $("#pwMsg").style.color = "var(--success)"; $("#pwMsg").textContent = "Password updated."; setTimeout(closeModals, 800); }
  else { $("#pwMsg").style.color = "var(--danger)"; $("#pwMsg").textContent = r.error || "Failed."; }
});

boot();
