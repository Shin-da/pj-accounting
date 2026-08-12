const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
/*
 * The maintenance page's front-end logic, tested against the real HTML/CSS
 * with a stubbed /api/health. Covers the four situations it has to tell
 * apart: explicit maintenance (must NOT auto-redirect), the database being
 * down (must show real elapsed time and self-heal), genuine recovery (must
 * redirect), and the server being unreachable entirely (distinct message).
 *
 *     npm i --no-save jsdom
 *     node test/maintenance-ui.js
 */
const APP = process.env.APP || require("path").join(__dirname, "..");

let ok = true;
const t = (n,c,x)=>{ if(!c) ok=false; console.log((c?'PASS ':'FAIL ')+n+(x!==undefined?'  → '+x:'')); };

function makeDom(responses) {
  const html = fs.readFileSync(APP + "/public/maintenance.html", "utf8");
  const css = fs.readFileSync(APP + "/public/style.css", "utf8");
  const dom = new JSDOM(html.replace("</head>", "<style>" + css + "</style></head>"),
    { runScripts: "outside-only", url: "http://localhost/", pretendToBeVisual: true });
  const w = dom.window;
  let call = 0;
  w.fetch = async () => {
    const body = responses[Math.min(call, responses.length - 1)];
    call++;
    return { ok: body.ok !== false, json: async () => body };
  };
  w.eval(fs.readFileSync(APP + "/public/maintenance.html", "utf8").match(/<script>([\s\S]*)<\/script>/)[1]);
  return { dom, w };
}
const wait = (ms=30) => new Promise(r => setTimeout(r, ms));

(async () => {
  // ── scenario 1: explicit maintenance, DB genuinely healthy ──
  // this is the exact case that used to bounce: ok:true was enough to trigger
  // a redirect, even though the server would just serve maintenance.html again.
  {
    const { w } = makeDom([{ maintenanceMode: true, ok: true, db: "up" }]);
    await wait();
    t('explicit maintenance: does NOT claim "back online"',
      !/Taking you in/.test(w.document.getElementById("heading").textContent),
      w.document.getElementById("heading").textContent);
    t('explicit maintenance: labels itself as scheduled, not a database problem',
      w.document.getElementById("reasonValue").textContent === "Planned maintenance");
    t('explicit maintenance: "ready to sign in" pill is NOT green (nothing to sign into yet)',
      !w.document.getElementById("pillReady").classList.contains("success"));
  }

  // ── scenario 2: database down, auto-detected ──
  {
    const downSince = new Date(Date.now() - 65000).toISOString();
    const { w } = makeDom([{ maintenanceMode: false, ok: false, db: "down", downSince,
      reason: "Could not reach Postgres at localhost:5432" }]);
    await wait();
    t('db-down: reason reads as a database problem, not "planned"',
      w.document.getElementById("reasonValue").textContent === "Database unreachable");
    t('db-down: shows elapsed downtime from the server-provided downSince',
      /1m/.test(w.document.getElementById("durationValue").textContent),
      w.document.getElementById("durationValue").textContent);
    t('db-down: does not falsely claim it is back',
      !/back online/i.test(w.document.getElementById("modeLabel").textContent.toLowerCase().replace('reconnecting','')));
  }

  // ── scenario 3: genuine recovery — THIS is the case that should redirect ──
  {
    const { w } = makeDom([{ maintenanceMode: false, ok: true, db: "up" }]);
    await wait();
    t('real recovery: DOES claim back online and schedules a redirect',
      /Taking you in/.test(w.document.getElementById("heading").textContent));
  }

  // ── scenario 4: /api/health itself unreachable (network/app down, not just DB) ──
  {
    const html = fs.readFileSync(APP + "/public/maintenance.html", "utf8");
    const css = fs.readFileSync(APP + "/public/style.css", "utf8");
    const dom = new JSDOM(html.replace("</head>", "<style>" + css + "</style></head>"),
      { runScripts: "outside-only", url: "http://localhost/", pretendToBeVisual: true });
    const w = dom.window;
    w.fetch = async () => { throw new Error("network error"); };
    w.eval(html.match(/<script>([\s\S]*)<\/script>/)[1]);
    await wait();
    t('server unreachable: distinct message, not confused with "database down"',
      w.document.getElementById("reasonValue").textContent === "No response from server");
  }

  console.log(ok ? '\nFRONT-END LOGIC CORRECT FOR ALL FOUR SCENARIOS' : '\nPROBLEMS FOUND');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERROR —', e.stack.split('\n').slice(0,5).join('\n')); process.exit(1); });
