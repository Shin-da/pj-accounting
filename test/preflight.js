/*
 * Pre-flight security check. Boots the real server against an in-memory
 * Postgres and drives it over HTTP as each role.
 *
 * The point of this file is one question: can a partner ever see or change
 * something they shouldn't? Supplier names, capital cost, margin and ONELIVE
 * profit must never leave the API for a partner, and every write endpoint
 * must refuse them.
 *
 *     npm i --no-save pg-mem
 *     node test/preflight.js
 */
const { newDb } = require('pg-mem');
const APP = __dirname;
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

(async () => {
  await db.init();
  const auth = require(APP + '/src/auth'), partners = require(APP + '/src/partners'), fs = require('fs');
  await partners.createPartner({ name: 'RDR' });
  await partners.createPartner({ name: 'Other' });
  await auth.createUser({ name:'Admin', email:'admin@x.com', role:'admin', password:'secret123' });
  await auth.createUser({ name:'RDR', email:'rdr@x.com', role:'partner', partner:'rdr', password:'secret123' });
  const real = JSON.parse(fs.readFileSync(APP + '/data/datasets/rdr.json','utf8'));
  await partners.saveDataset('rdr', real, { fileName:'live.xlsx' });
  await partners.saveDataset('other', real, { fileName:'other.xlsx' });

  const { app } = require(APP + '/src/server');
  const srv = require('http').createServer(app);
  await new Promise(r => srv.listen(5399, '127.0.0.1', r));
  const base = 'http://127.0.0.1:5399';
  const login = async (e) => { const r = await fetch(base+'/api/login',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'secret123'})});
    const c=r.headers.get('set-cookie'); return c?c.split(';')[0]:null; };
  const get = async (c,p) => (await fetch(base+p,{headers:c?{cookie:c}:{}})).json();
  const send = (c,m,p,body) => fetch(base+p,{method:m,headers:{cookie:c,'Content-Type':'application/json'},
    body: body?JSON.stringify(body):undefined});
  const FORBIDDEN = ['supplier','supplierPrice','capitalPerGram','cost','margin','onelive'];

  const pc = await login('rdr@x.com');
  const prep = await get(pc, '/api/report?partner=rdr');
  t('partner rows carry no supplier/cost/margin', FORBIDDEN.every(k => (prep.rows[0]||{})[k]===undefined),
    FORBIDDEN.filter(k=>(prep.rows[0]||{})[k]!==undefined).join(',')||'clean');
  t('partner KPIs carry no cost/margin/onelive', FORBIDDEN.every(k => prep.kpi[k]===undefined),
    FORBIDDEN.filter(k=>prep.kpi[k]!==undefined).join(',')||'clean');
  t('partner search cannot probe supplier names', (await get(pc,'/api/report?partner=rdr&q=IRYS')).rows.length===0);

  // asking for someone else's data must return YOUR OWN, never theirs
  const cross = await get(pc, '/api/report?partner=other');
  t('?partner= is clamped to the signed-in partner', cross.partner.slug === 'rdr', 'got ' + cross.partner.slug);

  t('partner blocked from /api/users', !!(await get(pc,'/api/users')).error);
  t('partner blocked from /api/portfolio', !!(await get(pc,'/api/portfolio')).error);
  t('partner cannot download the raw Excel',
    (await fetch(base+'/api/dataset-file?partner=rdr',{headers:{cookie:pc}})).status >= 400);
  const inv = await get(pc, '/api/invoice?partner=rdr&reserve=RDR0035');
  t('partner invoice detail hides supplier', FORBIDDEN.every(k => (inv.items[0]||{})[k]===undefined),
    FORBIDDEN.filter(k=>(inv.items[0]||{})[k]!==undefined).join(',')||'clean');

  // ── writes: a partner must not be able to change anything ──
  const paySt = await get(pc, '/api/payments?partner=rdr');
  t('partner sees the payout statement read-only', paySt.canRecord === false, 'canRecord=' + paySt.canRecord);
  t('partner cannot record a payment',
    (await send(pc,'POST','/api/payments',{partner:'rdr',amount:1,paidOn:'2026-08-01'})).status >= 400);
  t('partner cannot create an invoice',
    (await send(pc,'POST','/api/manual-invoice',{partner:'rdr',invoice:'X1',client:'c',date:'2026-08-01',items:[]})).status >= 400);
  t('partner cannot delete an invoice',
    (await send(pc,'DELETE','/api/manual-invoice?partner=rdr&invoice=RDR0035')).status >= 400);
  t('partner cannot change partner flags',
    (await send(pc,'PATCH','/api/partners/rdr',{flags:{cost:true}})).status >= 400);
  t('partner cannot create a user',
    (await send(pc,'POST','/api/users',{name:'x',email:'x@x.com',role:'admin',password:'abcdef'})).status >= 400);

  // flags stayed off after the attempts
  const after = await get(pc, '/api/report?partner=rdr');
  t('cost still hidden after the write attempts', after.kpi.cost === undefined);

  const ac = await login('admin@x.com');
  const arep = await get(ac, '/api/report?partner=rdr');
  t('admin still sees supplier + cost', arep.rows[0].supplier!==undefined && arep.kpi.cost!==undefined);
  t('admin can switch partners', (await get(ac,'/api/report?partner=other')).partner.slug === 'other');
  t('signed-out request is refused', !!(await get(null,'/api/report?partner=rdr')).error);

  const { aggregate } = require(APP + '/src/parse');
  const pay = require(APP + '/src/payments');
  const reg = aggregate((await partners.loadDataset('rdr')).records, {}).kpi.commissionValue;
  const earned = (await pay.summary('rdr')).earned;
  t('payouts equal the register', Math.abs(earned - reg) < 0.01,
    'register ' + reg.toFixed(2) + ' = payouts ' + earned.toFixed(2));
  t('/api/health responds', (await get(null,'/api/health')).ok !== undefined);

  srv.close();
  console.log(ok ? '\nPRE-FLIGHT CLEAN' : '\nPROBLEMS FOUND');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERROR —', e.stack.split('\n').slice(0,4).join('\n')); process.exit(1); });
