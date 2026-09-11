/*
 * Upload safeguard check. Boots the real server against an in-memory
 * Postgres and drives it over HTTP as an admin.
 *
 * The point of this file is one question: does uploading a sheet with far
 * fewer rows than what's currently loaded get caught before it silently
 * hides the rest of the register — and can that be undone from Upload
 * history afterward?
 *
 *     npm i --no-save pg-mem
 *     node test/upload-guard.js
 */
const { newDb } = require('pg-mem');
const XLSX = require('xlsx');
const APP = require('path').join(__dirname, '..');
const mem = newDb();
mem.public.registerFunction({ name:'now', returns:'timestamp', implementation:()=>new Date() });
const pgAdapter = mem.adapters.createPg();
const Module = require('module'); const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) { return r === 'pg' ? 'pg-mem-shim' : orig.call(this, r, ...rest); };
require.cache['pg-mem-shim'] = { id:'pg-mem-shim', filename:'pg-mem-shim', loaded:true, exports: pgAdapter };
process.env.DATABASE_URL = 'postgres://x/y';
const db = require(APP + '/src/db');
let ok = true;
const t = (n,c,x)=>{ if(!c) ok=false; console.log((c?'PASS ':'FAIL ')+n+(x!==undefined?'  → '+x:'')); };

// A tiny synthetic register: `n` rows, one client each, real enough for
// parse.js to accept (CLIENT NAME + AMOUNT, a master-sheet name).
function makeWorkbook(n, invoicePrefix) {
  const header = ['RESERVE NO.', 'INVOICE DATE (DD/MM/YYYY)', 'CLIENT NAME', 'AMOUNT'];
  const rows = [header];
  for (let i = 1; i <= n; i++) rows.push([`${invoicePrefix}${i}`, '01/08/2026', `Client ${i}`, 1000 + i]);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'SALES REPORT');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

(async () => {
  await db.init();
  const auth = require(APP + '/src/auth'), partners = require(APP + '/src/partners');
  await partners.createPartner({ name: 'RDR' });
  await auth.createUser({ name:'Admin', email:'admin@x.com', role:'admin', password:'secret123' });
  await auth.createUser({ name:'RDR', email:'rdr@x.com', role:'partner', partner:'rdr', password:'secret123' });

  // Seed 20 rows as the current dataset — the "full register" a partial
  // upload must not be able to silently bury.
  const seedRecords = Array.from({ length: 20 }, (_, i) => ({
    date: '2026-07-01', invoice: `SEED${i+1}`, client: `Seed Client ${i+1}`, amount: 500 + i,
  }));
  const seeded = await partners.saveDataset('rdr', { records: seedRecords, meta: {} }, { fileName: 'seed-full.xlsx' });

  const { app } = require(APP + '/src/server');
  const srv = require('http').createServer(app);
  await new Promise(r => srv.listen(5398, '127.0.0.1', r));
  const base = 'http://127.0.0.1:5398';
  const login = async (e) => { const r = await fetch(base+'/api/login',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'secret123'})});
    const c=r.headers.get('set-cookie'); return c?c.split(';')[0]:null; };
  const get = async (c,p) => (await fetch(base+p,{headers:c?{cookie:c}:{}})).json();
  const upload = async (c, buf, extra = {}) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'test.xlsx');
    fd.append('partner', 'rdr');
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    const resp = await fetch(base+'/api/upload', { method:'POST', headers:{cookie:c}, body: fd });
    return { status: resp.status, body: await resp.json() };
  };

  const ac = await login('admin@x.com');

  // ── a partial sheet (4 of 20 rows) must be stopped, not silently applied ──
  const partial = await upload(ac, makeWorkbook(4, 'NEW'));
  t('partial upload (4 of 20 rows) is refused pending confirmation', partial.status === 409 && partial.body.needsConfirmation === true,
    JSON.stringify(partial.body));
  t('refusal reports the real counts', partial.body.currentRows === 20 && partial.body.newRows === 4,
    `current=${partial.body.currentRows} new=${partial.body.newRows}`);

  const stillCurrent = await get(ac, '/api/partners/rdr/datasets');
  t('nothing was written by the refused upload',
    stillCurrent.datasets.length === 1 && stillCurrent.datasets[0].rows === 20 && String(stillCurrent.datasets[0].id) === String(seeded.datasetId),
    JSON.stringify(stillCurrent.datasets[0]));

  // ── a normal-sized update (18 of 20, an 90% overlap) must NOT be blocked ──
  const normal = await upload(ac, makeWorkbook(18, 'UPD'));
  t('a modest row-count drop (18 of 20) uploads without confirmation', normal.status === 200 && normal.body.ok === true,
    JSON.stringify(normal.body));

  // put the register back to 20 rows as the "current" baseline again, so the
  // next check is against a clean 20-row current dataset like before
  await partners.saveDataset('rdr', { records: seedRecords, meta: {} }, { fileName: 'seed-full-2.xlsx' });

  // ── force=1 pushes the partial upload through anyway ──
  const forced = await upload(ac, makeWorkbook(4, 'NEW2'), { force: '1' });
  t('force=1 uploads the partial sheet anyway', forced.status === 200 && forced.body.ok === true && forced.body.rows === 4,
    JSON.stringify(forced.body));

  const afterForce = await get(ac, '/api/partners/rdr/datasets');
  const oldFullId = afterForce.datasets.find(d => d.rows === 20).id;
  t('the old 20-row dataset still exists (nothing deleted)', !!oldFullId);
  t('the 4-row upload is now current', afterForce.datasets.find(d => d.is_current).rows === 4);

  // ── restore: the undo for the partial upload ──
  const restore = await (await fetch(base+`/api/partners/rdr/datasets/${oldFullId}/restore`, { method:'POST', headers:{cookie:ac} })).json();
  t('restore succeeds', restore.ok === true, JSON.stringify(restore));

  const afterRestore = await get(ac, '/api/partners/rdr/datasets');
  t('the 20-row dataset is current again', afterRestore.datasets.find(d => d.id === oldFullId).is_current === true);
  t('the report reflects the restored 20 rows', (await get(ac, '/api/report?partner=rdr')).kpi.lines === 20,
    JSON.stringify((await get(ac, '/api/report?partner=rdr')).kpi));

  // ── a non-admin cannot restore ──
  const pc = await login('rdr@x.com');
  const deniedRestore = await fetch(base+`/api/partners/rdr/datasets/${oldFullId}/restore`, { method:'POST', headers:{cookie:pc} });
  t('a partner user cannot call restore', deniedRestore.status >= 400 && deniedRestore.status < 500,
    'status=' + deniedRestore.status);

  await new Promise(r => srv.close(r));
  console.log(ok ? '\nALL PASS' : '\nFAILURES ABOVE');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('CRASHED:', e); process.exit(1); });
