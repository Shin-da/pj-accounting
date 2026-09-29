/*
 * pj-accounting has moved into the Perfect Jewel ERP (2026-09-29).
 *
 * This replaces the old server (src/server.js, still here for reference):
 * every page redirects to the ERP's accounting login, where partners sign in
 * with the same email and password; old API calls get a 410 saying where it
 * went. It never touches the database, so the Supabase project can be paused.
 *
 * To bring the old app back: set "start" in package.json to
 * "node src/server.js" again.
 */
const http = require("http");

const TARGET = (process.env.NEW_ACCOUNTING_URL || "https://perfectjewelryinc.itsshin.dev/accounting/").replace(/\/?$/, "/");
const PORT = Number(process.env.PORT) || 5055;

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
  const dest = path === "/login.html" ? TARGET + "login.html" : TARGET;
  res.writeHead(301, { Location: dest, "Cache-Control": "no-store" });
  res.end();
}).listen(PORT, () => console.log(` * pj-accounting retired — redirecting to ${TARGET} (port ${PORT})`));
