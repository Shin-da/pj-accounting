/*
 * pj-accounting has moved into the Perfect Jewel ERP (2026-09-29).
 *
 * This replaces the old server (src/server.js, still here for reference):
 * every page shows a short "we've moved" notice and then forwards to the
 * ERP's accounting login, where partners sign in with the same email and
 * password; old API calls get a 410 saying where it went. It never touches
 * the database, so the Supabase project can be paused.
 *
 * To bring the old app back: run "node src/server.js" again (on the droplet,
 * remove /etc/systemd/system/pj-accounting.service.d/retired.conf).
 */
const http = require("http");

const TARGET = (process.env.NEW_ACCOUNTING_URL || "https://perfectjewelryinc.itsshin.dev/accounting/").replace(/\/?$/, "/");
const PORT = Number(process.env.PORT) || 5055;
const SECONDS = 8;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function page(dest) {
  const d = esc(dest);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${SECONDS};url=${d}">
<meta name="robots" content="noindex">
<title>We've moved — Perfect Jewelry Partners</title>
<link rel="icon" href="${esc(TARGET)}logos/pj-logo.png">
<style>
  :root { --bg: #f5f5f4; --card: #ffffff; --text: #1c1917; --muted: #78716c; --border: #e7e5e4;
          --accent: #ba9731; --accent-text: #ffffff; --track: #eeeae3; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161412; --card: #1f1c19; --text: #f5f2ee; --muted: #a8a29e; --border: #33302c; --track: #2c2925; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
         background: var(--bg); color: var(--text); font: 15px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; }
  .card { width: min(460px, 100%); background: var(--card); border: 1px solid var(--border); border-radius: 14px;
          padding: 32px 28px 26px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .logo { width: 56px; height: 56px; object-fit: contain; margin-bottom: 14px; }
  h1 { font-size: 21px; margin: 0 0 8px; }
  p { margin: 0 0 12px; color: var(--muted); }
  .url { display: block; margin: 14px 0 18px; padding: 10px 12px; border: 1px dashed var(--border); border-radius: 8px;
         color: var(--text); font: 13.5px/1.4 ui-monospace, Consolas, monospace; word-break: break-all; text-decoration: none; }
  .btn { display: inline-block; background: var(--accent); color: var(--accent-text); text-decoration: none;
         font-weight: 600; padding: 10px 18px; border-radius: 8px; }
  .btn:focus-visible { outline: 3px solid var(--text); outline-offset: 2px; }
  .bar { height: 4px; background: var(--track); border-radius: 99px; overflow: hidden; margin: 20px 0 8px; }
  .bar > i { display: block; height: 100%; width: 100%; background: var(--accent); transform-origin: left;
             animation: shrink ${SECONDS}s linear forwards; }
  @keyframes shrink { to { transform: scaleX(0); } }
  @media (prefers-reduced-motion: reduce) { .bar > i { animation: none; } }
  .small { font-size: 12.5px; }
</style>
</head>
<body>
  <main class="card" role="main">
    <img class="logo" src="${esc(TARGET)}logos/pj-logo.png" alt="">
    <h1>We've moved</h1>
    <p>Partner sales &amp; commission accounting now lives in the Perfect Jewel system.</p>
    <p><strong style="color:var(--text)">Sign in with the same email and password</strong> — nothing else changes.</p>
    <a class="url" href="${d}">${d}</a>
    <a class="btn" href="${d}">Go to the new site now</a>
    <div class="bar" aria-hidden="true"><i></i></div>
    <p class="small" aria-live="polite">Taking you there in <span id="s">${SECONDS}</span> seconds… Please update your bookmark.</p>
  </main>
<script>
  (function () {
    var n = ${SECONDS}, el = document.getElementById("s");
    var t = setInterval(function () {
      n -= 1; if (el) el.textContent = Math.max(n, 0);
      if (n <= 0) { clearInterval(t); location.replace(${JSON.stringify(dest)}); }
    }, 1000);
  })();
</script>
</body>
</html>`;
}

http.createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (path === "/healthz" || path === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, retired: true, movedTo: TARGET }));
  }
  if (path.startsWith("/api/")) {
    res.writeHead(410, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: `This app has moved to ${TARGET}`, movedTo: TARGET }));
  }
  const dest = TARGET + "login.html";
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(page(dest));
}).listen(PORT, () => console.log(` * pj-accounting retired — notice page forwarding to ${TARGET} (port ${PORT})`));
