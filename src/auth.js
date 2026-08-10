/*
 * Authentication + accounts — no external deps.
 *
 *  - Passwords hashed with Node's crypto.scrypt (salt + hash), never stored plain.
 *  - Sessions are a signed cookie (HMAC-SHA256), so no server-side store is
 *    needed and logins survive restarts / work on serverless hosts.
 *  - Roles: "admin" (full + upload + user/partner admin), "owner" (read-only
 *    portfolio across all partners), "partner" (own report only).
 *
 * On first run a single admin account is seeded (you), with a random temporary
 * password printed to the server console; create everyone else in-app.
 */
const fs = require("fs");
const crypto = require("crypto");
const { USERS_JSON, AUTH_SECRET, SESSION_TTL_MS } = require("../config");

const COOKIE = "pj_sess";
const ROLES = ["admin", "owner", "partner"];

// ── persistence ──────────────────────────────────────────
function load() {
  try { return JSON.parse(fs.readFileSync(USERS_JSON, "utf8")); } catch (_) { return []; }
}
function save(users) { fs.writeFileSync(USERS_JSON, JSON.stringify(users, null, 2)); }

// ── password hashing ─────────────────────────────────────
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(pw, salt, hash) {
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return h.length === hash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
}

// ── session cookie (signed, stateless) ───────────────────
function signToken(obj) {
  const p = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const sig = crypto.createHmac("sha256", AUTH_SECRET).update(p).digest("base64url");
  return p + "." + sig;
}
function verifyToken(token) {
  if (!token || token.indexOf(".") < 0) return null;
  const [p, sig] = token.split(".");
  const expect = crypto.createHmac("sha256", AUTH_SECRET).update(p).digest("base64url");
  if (!sig || sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const obj = JSON.parse(Buffer.from(p, "base64url").toString());
    if (Date.now() - obj.iat > SESSION_TTL_MS) return null;
    return obj;
  } catch (_) { return null; }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// ── public shape (never leak salt/hash) ──────────────────
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role, partner: u.partner || null,
           disabled: !!u.disabled, mustChange: !!u.mustChange };
}

// ── account operations ───────────────────────────────────
function findByEmail(email) {
  const e = String(email || "").toLowerCase().trim();
  return load().find((u) => u.email.toLowerCase() === e) || null;
}
function findById(id) { return load().find((u) => u.id === id) || null; }

function createUser({ email, name, role, partner, password }) {
  const users = load();
  if (!email || !password) throw new Error("email and password required");
  if (!ROLES.includes(role)) throw new Error("invalid role");
  if (users.some((u) => u.email.toLowerCase() === String(email).toLowerCase())) throw new Error("email already exists");
  const { salt, hash } = hashPassword(password);
  const u = { id: crypto.randomUUID(), email: String(email).trim(), name: name || email,
    role, partner: role === "partner" ? (partner || null) : null,
    salt, hash, disabled: false, mustChange: true, createdAt: new Date().toISOString() };
  users.push(u); save(users);
  return publicUser(u);
}
function updateUser(id, patch) {
  const users = load();
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error("user not found");
  if (patch.name != null) u.name = patch.name;
  if (patch.role != null) { if (!ROLES.includes(patch.role)) throw new Error("invalid role"); u.role = patch.role; }
  if (patch.partner !== undefined) u.partner = u.role === "partner" ? (patch.partner || null) : null;
  if (patch.disabled != null) u.disabled = !!patch.disabled;
  if (patch.password) { const { salt, hash } = hashPassword(patch.password); u.salt = salt; u.hash = hash; u.mustChange = !!patch.mustChange; }
  save(users);
  return publicUser(u);
}
function setOwnPassword(id, newPassword) {
  const users = load();
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error("user not found");
  const { salt, hash } = hashPassword(newPassword);
  u.salt = salt; u.hash = hash; u.mustChange = false;
  save(users);
  return publicUser(u);
}
function listUsers() { return load().map(publicUser); }

function authenticate(email, password) {
  const u = findByEmail(email);
  if (!u || u.disabled) return null;
  if (!verifyPassword(password, u.salt, u.hash)) return null;
  return u;
}

// ── middleware ───────────────────────────────────────────
function attachUser(req, res, next) {
  const tok = parseCookies(req)[COOKIE];
  const sess = verifyToken(tok);
  req.user = sess ? publicUser(findById(sess.uid)) : null;
  if (req.user && req.user.disabled) req.user = null;
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "not signed in" });
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "not signed in" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "forbidden" });
    next();
  };
}
function setSession(res, user) {
  res.cookie(COOKIE, signToken({ uid: user.id, iat: Date.now() }), {
    httpOnly: true, sameSite: "lax", maxAge: SESSION_TTL_MS,
  });
}
function clearSession(res) { res.clearCookie(COOKIE); }

// ── seed ─────────────────────────────────────────────────
function seedIfEmpty(adminEmail) {
  const users = load();
  if (users.length) return null;
  const temp = crypto.randomBytes(6).toString("base64url"); // ~8 chars
  const { salt, hash } = hashPassword(temp);
  const u = { id: crypto.randomUUID(), email: adminEmail, name: "Accounting Admin",
    role: "admin", partner: null, salt, hash, disabled: false, mustChange: true,
    createdAt: new Date().toISOString() };
  save([u]);
  console.log("\n ┌─────────────────────────────────────────────");
  console.log(" │  Seeded first admin account:");
  console.log(" │    email:    " + adminEmail);
  console.log(" │    password: " + temp + "   (change it after first login)");
  console.log(" └─────────────────────────────────────────────\n");
  return temp;
}

module.exports = {
  ROLES, attachUser, requireAuth, requireRole, setSession, clearSession,
  authenticate, publicUser, createUser, updateUser, setOwnPassword, listUsers,
  findById, findByEmail, seedIfEmpty,
};
