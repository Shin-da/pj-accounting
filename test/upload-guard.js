/*
 * Upload-merge check. Boots the real server against an in-memory Postgres
 * and drives it over HTTP as an admin.
 *
 * The point of this file is one question: when a new Excel is uploaded, does
 * the database stay the source of truth — new rows added, unchanged rows
 * left alone, and a row that matches but changed held back until an admin
 * explicitly approves overwriting it — instead of the old file wiping
 * anything out?
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

// A tiny synthetic register: rows with an invoice, PJ code, item code, client
// and amount — real enough for parse.js to accept (CLIENT NAME + AMOUNT on a
// master-sheet name).
function makeWorkbook(rows) {
  const header = ['RESERVE NO.', 'INVOICE DATE (DD/MM/YYYY)', 'CLIENT NAME', 'PJ CODE', 'ITEM CODE', 'AMOUNT'];
  const aoa = [header];
  for (const r of rows) aoa.push([r.invoice, '01/08/2026', r.client, r.pjCode, r.itemCode, r.amount]);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, 'SALES REPORT');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

(async () => {
  await db.init();
  const auth = require(APP + '/src/auth'), partners = require(APP + '/src/partners');
  await partners.createPartner({ name: 'RDR' });
  await auth.createUser({ name:'Admin', email:'admin@x.com', role:'admin', password:'secret123' });
  await auth.createUser({ name:'RDR', email:'rdr@x.com', role:'partner', partner:'rdr', password:'secret123' });

  // Seed 5 rows as the live dataset — the baseline every merge is measured against.
  const seedRows = [
    { invoice: 'SEED1', client: 'Client A', pjCode: 'PJ001', itemCode: 'IT001', amount: 500 },
    { invoice: 'SEED2', client: 'Client B', pjCode: 'PJ002', itemCode: 'IT002', amount: 600 },
    { invoice: 'SEED3', client: 'Client C', pjCode: 'PJ003', itemCode: 'IT003', amount: 700 },
    { invoice: 'SEED4', client: 'Client D', pjCode: 'PJ004', itemCode: 'IT004', amount: 800 },
    { invoice: 'SEED5', client: 'Client E', pjCode: 'PJ005', itemCode: 'IT005', amount: 900 },
  ];
  const seedRecords = seedRows.map((r) => ({ date: '2026-08-01', supplier: '—', ...r }));
  await partners.saveDataset('rdr', { records: seedRecords, meta: {} }, { fileName: 'seed-full.xlsx' });

  const { app } = require(APP + '/src/server');
  const srv = require('http').createServer(app);
  await new Promise(r => srv.listen(5398, '127.0.0.1', r));
  const base = 'http://127.0.0.1:5398';
  const login = async (e) => { const r = await fetch(base+'/api/login',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'secret123'})});
    const c=r.headers.get('set-cookie'); return c?c.split(';')[0]:null; };
  const get = async (c,p) => (await fetch(base+p,{headers:c?{cookie:c}:{}})).json();
  const upload = async (c, buf) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'test.xlsx');
    fd.append('partner', 'rdr');
    const resp = await fetch(base+'/api/upload', { method:'POST', headers:{cookie:c}, body: fd });
    return { status: resp.status, body: await resp.json() };
  };

  const ac = await login('admin@x.com');

  // ── a follow-up file: SEED1 unchanged, SEED2 with a different amount
  //    (a conflict), SEED3-5 simply not mentioned, plus two brand-new rows ──
  const follow = await upload(ac, makeWorkbook([
    { invoice: 'SEED1', client: 'Client A', pjCode: 'PJ001', itemCode: 'IT001', amount: 500 },
    { invoice: 'SEED2', client: 'Client B', pjCode: 'PJ002', itemCode: 'IT002', amount: 650 },
    { invoice: 'NEW1', client: 'Client F', pjCode: 'PJ006', itemCode: 'IT006', amount: 111 },
    { invoice: 'NEW2', client: 'Client G', pjCode: 'PJ007', itemCode: 'IT007', amount: 222 },
  ]));
  t('merge upload succeeds', follow.status === 200 && follow.body.ok === true, JSON.stringify(follow.body));
  t('two genuinely new rows are added', follow.body.added === 2, 'added=' + follow.body.added);
  t('the identical row is left alone, not re-flagged', follow.body.unchanged === 1, 'unchanged=' + follow.body.unchanged);
  t('the changed row comes back as a conflict, not auto-applied',
    follow.body.conflicts.length === 1 && follow.body.conflicts[0].invoice === 'SEED2',
    JSON.stringify(follow.body.conflicts));

  const afterMerge = await get(ac, '/api/report?partner=rdr');
  t('nothing was deleted: 5 original + 2 new = 7 rows visible', afterMerge.kpi.lines === 7,
    'lines=' + afterMerge.kpi.lines);
  t('the unresolved conflict keeps the OLD value until approved',
    afterMerge.kpi.amount === (500+600+700+800+900+111+222),
    'amount=' + afterMerge.kpi.amount);

  // ── SEED3/4/5 (not mentioned in the new file) must still be there ──
  const invoices = await get(ac, '/api/invoices?partner=rdr');
  const stillThere = ['SEED3', 'SEED4', 'SEED5'].every((no) => invoices.invoices.some((i) => i.reserve === no));
  t('rows the new file never mentioned are untouched, not dropped', stillThere);

  // ── a non-admin cannot resolve conflicts ──
  const pc = await login('rdr@x.com');
  const decisions = follow.body.conflicts.map((c) => ({ recordId: c.recordId, incoming: c.incoming }));
  const deniedResolve = await fetch(base+'/api/upload/resolve', { method:'POST',
    headers:{cookie:pc,'Content-Type':'application/json'}, body: JSON.stringify({ partner:'rdr', decisions }) });
  t('a partner user cannot resolve conflicts', deniedResolve.status >= 400 && deniedResolve.status < 500,
    'status=' + deniedResolve.status);

  // ── the admin approves overwriting SEED2's amount ──
  const resolved = await (await fetch(base+'/api/upload/resolve', { method:'POST',
    headers:{cookie:ac,'Content-Type':'application/json'}, body: JSON.stringify({ partner:'rdr', decisions }) })).json();
  t('resolve applies the approved row', resolved.ok === true && resolved.applied === 1, JSON.stringify(resolved));

  const afterResolve = await get(ac, '/api/report?partner=rdr');
  t('the approved overwrite is now reflected', afterResolve.kpi.amount === (500+650+700+800+900+111+222),
    'amount=' + afterResolve.kpi.amount);
  t('row count is unchanged by a resolve (update, not insert)', afterResolve.kpi.lines === 7,
    'lines=' + afterResolve.kpi.lines);

  await new Promise(r => srv.close(r));
  console.log(ok ? '\nALL PASS' : '\nFAILURES ABOVE');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('CRASHED:', e); process.exit(1); });
