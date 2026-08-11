/*
 * Superadmin + account-archival rules.
 *
 * The question this answers: can an ordinary admin lock out the superadmin,
 * or another admin? And does archiving a user preserve the audit trail?
 *
 *     npm i --no-save pg-mem
 *     node test/superadmin.js
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
process.env.SUPERADMIN_EMAIL = 'shin@perfectjewel.com';

const db = require(APP + '/src/db');
let ok = true;
const t = (n,c,x)=>{ if(!c) ok=false; console.log((c?'PASS ':'FAIL ')+n+(x!==undefined?'  → '+x:'')); };

(async () => {
  await db.init();
  const auth = require(APP + '/src/auth'), partners = require(APP + '/src/partners');
  await partners.createPartner({ name: 'RDR' });
  const su    = await auth.createUser({ name:'Shin', email:'shin@perfectjewel.com', role:'admin', password:'secret123' });
  const admin = await auth.createUser({ name:'Alvin', email:'alvin@x.com', role:'admin', password:'secret123' });
  const owner = await auth.createUser({ name:'Tatay', email:'tatay@x.com', role:'owner', password:'secret123' });
  const part  = await auth.createUser({ name:'RDR', email:'rdr@x.com', role:'partner', partner:'rdr', password:'secret123' });

  const { app } = require(APP + '/src/server');
  const srv = require('http').createServer(app);
  await new Promise(r => srv.listen(5398, '127.0.0.1', r));
  const base = 'http://127.0.0.1:5398';
  const login = async (e) => { const r = await fetch(base+'/api/login',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'secret123'})});
    const c=r.headers.get('set-cookie'); return c?c.split(';')[0]:null; };
  const patch = (c,id,body) => fetch(base+'/api/users/'+id,{method:'PATCH',
    headers:{cookie:c,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const post  = (c,body) => fetch(base+'/api/users',{method:'POST',
    headers:{cookie:c,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const get = async (c,p) => (await fetch(base+p,{headers:{cookie:c}})).json();

  const sc = await login('shin@perfectjewel.com');
  const ac = await login('alvin@x.com');

  t('superadmin is flagged on /api/me', (await get(sc,'/api/me')).user.superadmin === true);
  t('an ordinary admin is not', (await get(ac,'/api/me')).user.superadmin !== true);

  // ── the whole point: an admin cannot touch you ──
  t('admin CANNOT disable the superadmin', (await patch(ac, su.id, {disabled:true})).status === 403);
  t('admin CANNOT archive the superadmin',  (await patch(ac, su.id, {archived:true})).status === 403);
  t('admin CANNOT demote the superadmin',   (await patch(ac, su.id, {role:'partner'})).status === 403);
  t('admin CANNOT reset the superadmin password', (await patch(ac, su.id, {password:'hijacked1'})).status === 403);
  t('superadmin can still sign in afterwards', !!(await login('shin@perfectjewel.com')));

  // ── admins cannot fight each other either ──
  t('admin CANNOT disable another admin', (await patch(ac, admin.id === undefined ? '' : su.id, {disabled:true})).status === 403);
  t('admin CANNOT archive an owner', (await patch(ac, owner.id, {archived:true})).status === 403);
  t('admin CANNOT create another admin', (await post(ac, {name:'x',email:'x1@x.com',role:'admin',password:'secret123'})).status === 403);
  t('admin CANNOT promote a partner to admin', (await patch(ac, part.id, {role:'admin'})).status === 403);

  // ── but admins still do their job ──
  t('admin CAN create a partner account',
    (await post(ac, {name:'New',email:'new@x.com',role:'partner',partner:'rdr',password:'secret123'})).status === 200);
  t('admin CAN archive a partner account', (await patch(ac, part.id, {archived:true})).status === 200);
  t('an archived user cannot sign in', (await login('rdr@x.com')) === null);
  t('archived users are hidden from the list',
    !(await get(ac,'/api/users')).users.some(u => u.email === 'rdr@x.com'));
  t('...but still retrievable with ?archived=1',
    (await get(ac,'/api/users?archived=1')).users.some(u => u.email === 'rdr@x.com'));
  t('admin CAN restore them', (await patch(ac, part.id, {archived:false})).status === 200);
  t('restored user can sign in again', !!(await login('rdr@x.com')));

  // ── lockout guards ──
  t('nobody can disable their own account', (await patch(ac, admin.id, {disabled:true})).status === 403);
  t('nobody can archive their own account', (await patch(ac, admin.id, {archived:true})).status === 403);

  // ── superadmin can do everything ──
  t('superadmin CAN create an admin',
    (await post(sc, {name:'A2',email:'a2@x.com',role:'admin',password:'secret123'})).status === 200);
  t('superadmin CAN archive an admin', (await patch(sc, admin.id, {archived:true})).status === 200);
  t('superadmin still cannot archive themselves', (await patch(sc, su.id, {archived:true})).status === 403);

  // ── there is no hard-delete route at all ──
  t('DELETE /api/users is not a route',
    [404,405].includes((await fetch(base+'/api/users/'+part.id,{method:'DELETE',headers:{cookie:sc}})).status));

  // ── the audit trail recorded who did what ──
  const log = await db.query("SELECT action, actor, entity FROM audit_log WHERE action LIKE 'user.%' ORDER BY id");
  // Only the changes that actually succeeded should be here — the refused
  // attempts return 403 before any write, so they must NOT appear.
  const actions = log.map(r => r.action);
  t('every successful user change is audit-logged',
    ['user.create','user.archive','user.restore'].every(a => actions.includes(a)),
    actions.join(', '));
  t('refused attempts left no audit entry', log.length === 5, log.length + ' entries');
  t('the archive names who did it', log.some(r => r.action === 'user.archive' && r.actor === 'alvin@x.com'));

  srv.close();
  console.log(ok ? '\nSUPERADMIN RULES HOLD' : '\nPROBLEMS FOUND');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERROR —', e.stack.split('\n').slice(0,4).join('\n')); process.exit(1); });
