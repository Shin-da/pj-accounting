/*
 * UI smoke test — runs the real index.html + app.js in jsdom against a stubbed
 * API, and checks the things that are easy to break by hand:
 *   - the register renders and its identifier cells drill through
 *   - clicking a client / type / invoice filters or navigates correctly
 *   - a client name containing a quote can't break out of an HTML attribute
 *   - the invoice editor opens, adds lines, and auto-calculates commission
 *
 * jsdom is intentionally NOT a dependency (it is ~50 MB and Render would
 * install it on every deploy). Install it just for the run:
 *
 *     npm i --no-save jsdom
 *     node test/ui-smoke.js
 */
let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch { console.error("This test needs jsdom:  npm i --no-save jsdom"); process.exit(2); }
const fs = require("fs");
const APP = process.env.APP || require("path").join(__dirname, "..");

const ROWS = [
  { date:"2026-07-29", invoice:"RDR0035", pjCode:"PJ001", itemCode:"IC1", client:'JAS"MIN PEDROSA',
    supplier:"IRYS", commissionType:"GOLD", weight:5, supplierPrice:100, amount:1000,
    commissionRate:"0.05", commissionValue:50 },
  { date:"2026-07-22", invoice:"RDR0032", pjCode:"PJ002", itemCode:"IC2", client:"LONGAYAN LILY",
    supplier:"IRYS", commissionType:"JEWELRY", weight:2, supplierPrice:50, amount:500,
    commissionRate:"0.05", commissionValue:25 },
];
const REPORT = {
  meta:{ fileName:"x.xlsx", uploadedAt:"2026-08-01T00:00:00Z" }, rows: ROWS, rowsTotal: 2,
  typeDimension:"commission",
  kpi:{ amount:1500, commissionValue:75, invoices:2, clients:2, weight:7, lines:2 },
  totals:{ count:2, amount:1500, commissionValue:75, weight:7, supplierPrice:150 },
  months:[{month:"2026-07", amount:1500, commissionValue:75}],
  clients:[{client:'JAS"MIN PEDROSA', invoices:1, amount:1000, commissionValue:50},
           {client:"LONGAYAN LILY", invoices:1, amount:500, commissionValue:25}],
  types:[{itemType:"GOLD", count:1, weight:5, amount:1000, commissionValue:50},
         {itemType:"JEWELRY", count:1, weight:2, amount:500, commissionValue:25}],
  filterOptions:{ clients:['JAS"MIN PEDROSA', "LONGAYAN LILY"] },
  payout:{ earned:75, paid:0, balance:75 },
};
const ROUTES = {
  "/api/me": { authed:true, currency:"₱", user:{name:"Shin",email:"a@b.c",role:"admin"},
               partners:[{slug:"rdr", name:"RDR", hasLogo:false}] },
  "/api/report": REPORT,
  "/api/invoices": { invoices:[
      { reserve:"RDR0035", clients:['JAS"MIN PEDROSA'], date:"2026-07-29", count:1, amount:1000, source:"import" },
      { reserve:"RDR1111111", clients:["Mathew Test"], date:"2026-08-08", count:3, amount:2534, source:"manual" } ] },
  "/api/invoice": { reserve:"RDR0035", date:"2026-07-29", clients:['JAS"MIN PEDROSA'], source:"import",
      canEdit:false, canUpload:true, items:[ROWS[0]], totals:{count:1, amount:1000, commissionValue:50} },
  "/api/partners": { partners:[] },
  "/api/payments": { summary:{earned:75,paid:0,balance:75,status:"unpaid"}, payments:[], canEdit:true },
};
const calls = [];
async function fakeFetch(url) {
  calls.push(url);
  const path = String(url).split("?")[0];
  return { json: async () => ROUTES[path] ?? {} };
}

const html = fs.readFileSync(APP + "/public/index.html", "utf8");
// jsdom does not fetch <link rel=stylesheet>, so inline the real stylesheet.
// Without this every cssVar() lookup returns "" and silently falls back to the
// hardcoded defaults — which makes the colour assertions below pass on values
// that never came from the theme at all.
const css = fs.readFileSync(APP + "/public/style.css", "utf8");
const dom = new JSDOM(html.replace("</head>", "<style>" + css + "</style></head>"),
  { runScripts: "outside-only", url: "http://localhost/", pretendToBeVisual: true });
const w = dom.window;
w.fetch = fakeFetch;
const drawn = {};
w.Chart = class {                       // records the config so we can inspect series colours
  constructor(el, cfg){ drawn[el && el.id] = cfg; }
  destroy(){}
};
w.alert = () => {}; w.confirm = () => true;
w.Element.prototype.scrollIntoView = function(){};   // not implemented by jsdom
w.eval(fs.readFileSync(APP + "/public/app.js", "utf8"));

const $ = (s) => w.document.querySelector(s);
const $$ = (s) => [...w.document.querySelectorAll(s)];
const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
const wait = () => new Promise(r => setTimeout(r, 60));
let ok = true;
const t = (name, cond, extra) => { if (!cond) ok = false;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  → " + extra : "")); };

(async () => {
  await wait(); await wait(); await wait();

  // ── 1. the register renders and its identifier cells are drillable ──
  const reg = $$("#tblRegister tbody tr");
  t("register rendered", reg.length === 2, reg.length + " rows");
  const links = $$("#tblRegister [data-drill]");
  const kinds = [...new Set(links.map(l => l.dataset.drill))].sort();
  t("invoice / client / code / type cells are clickable",
    kinds.join(",") === "client,invoice,q,type", kinds.join(","));

  const invLink = $('#tblRegister [data-drill="invoice"]');
  t("invoice number carries its value", invLink.dataset.val === "RDR0035", invLink.dataset.val);
  const clientLink = $('#tblRegister [data-drill="client"]');
  t("client name with a quote survives", clientLink.dataset.val === 'JAS"MIN PEDROSA', clientLink.dataset.val);
  t("client hover shows a summary", /1 invoice · ₱1,000.00 sales/.test(clientLink.title), clientLink.title);
  t("totals row still present", $("#tblRegister tfoot td b") !== null);

  // ── 2. clicking a client filters and lands on the register ──
  click(clientLink); await wait(); await wait();
  const saved = () => JSON.parse(w.localStorage.getItem("pj-filters") || "{}");
  t("client click sets the filter", saved().client === 'JAS"MIN PEDROSA', saved().client);
  t("the filter reaches the API call", calls.some(u => /client=JAS%22MIN\+PEDROSA/.test(u)),
    calls[calls.length - 1]);
  t("client click switches to the register", !!$("#page-register.active"));
  t("client added to the dropdown", $("#fClient").value === 'JAS"MIN PEDROSA');
  const chip = $(".fchip");
  t("an active-filter chip appears", !!chip && /JAS"MIN PEDROSA/.test(chip.textContent), chip && chip.textContent.trim());

  // ── 3. the chip removes the filter again ──
  click($(".fchip button")); await wait(); await wait();
  t("chip × clears the filter", !saved().client && $(".fchip") === null);

  // ── 4. clicking a type filters by commission type ──
  click($('#tblRegister [data-drill="type"]')); await wait(); await wait();
  t("type click sets commType", String(saved().commType).toLowerCase() === "gold", saved().commType);
  click($(".fchip button")); await wait();

  // ── 5. clicking an invoice number opens that invoice ──
  click($('#tblRegister [data-drill="invoice"]')); await wait(); await wait(); await wait();
  t("invoice click switches to Invoices", !!$("#page-invoices.active"));
  t("invoice detail opened", /RDR0035/.test($("#invDetail").textContent), $(".inv-reserve") && $(".inv-reserve").textContent);
  t("the right row is highlighted", ($(".inv-row.active") || {}).dataset?.reserve === "RDR0035");
  t("client in the invoice header is clickable", !!$('#invDetail [data-drill="client"]'));

  // ── 6. the editor modal ──
  click($("#btnNewInvoice")); await wait();
  t("modal opens", $("#invModal").classList.contains("open"));
  t("modal has sticky head / body / foot",
    !!$("#invModal .modal-head") && !!$("#invModal .modal-body") && !!$("#invModal .modal-foot"));
  const heads = $$("#invItems thead th").length;
  const colspec = $$("#invItems colgroup col").length;
  t("every line-item column has a fixed width", heads === colspec && heads === 12, heads + " cols");
  t("known clients offered as suggestions", $$("#clientList option").length === 2);
  t("starts with one blank line", $$("#invItems tbody tr").length === 1);

  click($("#btnAddLine")); await wait();
  t("+ Add line adds a row", $$("#invItems tbody tr").length === 2);
  click($("#btnDupLine")); await wait();
  t("Duplicate last adds a row", $$("#invItems tbody tr").length === 3);

  // commission still auto-calculates
  const setVal = (i,k,v) => { const el = $(`#invItems [data-i="${i}"][data-k="${k}"]`);
    el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); };
  setVal(0, "commissionType", "JEWELRY"); setVal(0, "amount", "10000"); setVal(0, "commissionRate", "0.05");
  await wait();
  t("jewelry commission = rate × amount", /₱500\.00/.test($("#invTotals").textContent), $("#invTotals").textContent.trim());
  setVal(1, "commissionType", "GOLD"); setVal(1, "weight", "10"); setVal(1, "commissionRate", "50");
  await wait();
  t("gold commission = rate × weight", /₱1,000\.00/.test($("#invTotals").textContent), $("#invTotals").textContent.trim());

  // Esc closes
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait();
  t("Esc closes the modal", !$("#invModal").classList.contains("open"));


  // ── 7. theme-aware chart colours ──
  t("stylesheet is loaded (guards every colour check below)",
    w.getComputedStyle(w.document.documentElement).getPropertyValue("--c-sales").trim() === "#4f46e5",
    JSON.stringify(w.getComputedStyle(w.document.documentElement).getPropertyValue("--c-sales")));

  const seriesOf = (id) => {
    const d = drawn[id] && drawn[id].data.datasets[0];
    return d ? (d.borderColor || d.backgroundColor) : null;
  };
  const lightSales = seriesOf("chTime");
  const lightPie = drawn.chType.data.datasets[0].backgroundColor.slice();
  t("chart colours come from the stylesheet, not hex literals",
    typeof lightSales === "string" && lightSales.length > 0, lightSales);

  // GOLD must be gold and JEWELRY teal, regardless of ordering
  const labels = drawn.chType.data.labels;
  const gi = labels.indexOf("GOLD"), ji = labels.indexOf("JEWELRY");
  t("GOLD slice uses the gold token", lightPie[gi] === "#a87a2b", lightPie[gi]);
  t("JEWELRY slice uses the jewelry token", lightPie[ji] === "#0f766e", lightPie[ji]);
  t("donut slices have a separating border",
    drawn.chType.data.datasets[0].borderWidth === 2);

  w.eval('applyTheme("dark")'); await wait();
  const darkSales = seriesOf("chTime");
  const darkPie = drawn.chType.data.datasets[0].backgroundColor;
  t("switching to dark recolours the sales series", darkSales !== lightSales,
    lightSales + " -> " + darkSales);
  t("dark sales series is the light indigo", darkSales === "#818cf8", darkSales);
  t("dark GOLD slice brightens", darkPie[gi] === "#e0b341", darkPie[gi]);
  t("dark JEWELRY slice brightens", darkPie[ji] === "#2dd4bf", darkPie[ji]);
  w.eval('applyTheme("light")'); await wait();

  // ── 8. type pills carry the category colour into the tables ──
  const pills = $$("#tblRegister .pill-type");
  t("commission types render as coloured pills", pills.length === 2, pills.length + " pills");
  t("gold and jewelry pills differ",
    pills.length === 2 && pills[0].className !== pills[1].className,
    pills.length === 2 ? pills[0].className + " / " + pills[1].className : "");

  console.log(ok ? "\nALL PASS" : "\nFAILURES");
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error("ERROR —", e.stack); process.exit(1); });
