/*
 * Authentication + accounts — PostgreSQL backed.
 *
 *  - Passwords hashed with crypto.scrypt (salt + hash), never stored plain.
 *  - Sessions are a signed cookie (HMAC-SHA256), so there is no server-side
 *    session store to lose on restart.
 *  - Roles: "admin" (full + upload + user/partner admin), "owner" (read-only
 *    portfolio across all partners), "partner" (own report only).
 *
 * Everything here is async now that it talks to a database. The session
 * secret lives in the settings table so logins survive a redeploy.
 */
const crypto = require("crypto");
const db = require("./db");
const { SESSION_TTL_MS } = require("../config");

const COOKIE = "pj_sess";
const ROLES = ["admin", "owner", "partner"];

// Loaded once at startup by initSecret().
let AUTH_SECRET = process.env.AUTH_SECRET || "";

/** Ensure we have a stable signing secret (env wins; otherwise persist one). */
async function initSecret() {
  if (AUTH_SECRET) return;
  let s = await db.getSetting("auth_secret");
  if (!s) {
    s = crypto.randomBytes(32).toString("hex");
    await db.setSetting("auth_secret", s);
  }
  AUTH_SECRET = s;
}

// ── password hashing ─────────────────────────────────────
function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 64).toString("hex");
}
function createSalt() {
  return crypto.randomBytes(16).toString("hex");
}
function verifyPassword(pw, salt, expected) {
  if (!salt || !expected) return false;
  const actual = hashPassword(pw, salt);
  return actual.length === expected.length &&
         crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
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
  if (!sig || sig.length !== expect.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const obj = JSON.parse(Buffer.from(p, "base64url").toString());
    if (Date.now() - obj.iat > SESSION_TTL_MS) return null;
    return obj;
  } catch (_) { return null; }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// ── shape returned to the client (never leak salt/hash) ──
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role,
           partner: u.partner_slug || null,
           disabled: !!u.disabled, mustChange: !!u.must_change };
}

// ── account operations ───────────────────────────────────
async function findByEmail(email) {
  return db.one("SELECT * FROM users WHERE lower(email) = lower($1)", [String(email || "").trim()]);
}
async function findById(id) {
  return db.one("SELECT * FROM users WHERE id = $1", [id]);
}
async function listUsers() {
  const rows = await db.query("SELECT * FROM users ORDER BY created_at");
  return rows.map(publicUser);
}

async function createUser({ email, name, role, partner, password, mustChange = true }) {
  if (!email || !password) throw new Error("email and password required");
  if (!ROLES.includes(role)) throw new Error("invalid role");
  if (await findByEmail(email)) throw new Error("email already exists");

  const salt = createSalt();
  const row = await db.one(
    `INSERT INTO users (id, email, name, role, partner_slug, password_hash, password_salt, must_change)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [crypto.randomUUID(), String(email).trim(), name || email, role,
     role === "partner" ? (partner || null) : null,
     hashPassword(password, salt), salt, !!mustChange]);
  return publicUser(row);
}

async function updateUser(id, patch) {
  const u = await findById(id);
  if (!u) throw new Error("user not found");

  const sets = [], vals = [];
  const put = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

  if (patch.name != null) put("name", patch.name);
  if (patch.role != null) {
    if (!ROLES.includes(patch.role)) throw new Error("invalid role");
    put("role", patch.role);
    // clearing partner when leaving the partner role keeps the data honest
    if (patch.role !== "partner") put("partner_slug", null);
  }
  if (patch.partner !== undefined) {
    const role = patch.role || u.role;
    put("partner_slug", role === "partner" ? (patch.partner || null) : null);
  }
  if (patch.disabled != null) put("disabled", !!patch.disabled);
  if (patch.password) {
    const salt = createSalt();
    put("password_hash", hashPassword(patch.password, salt));
    put("password_salt", salt);
    put("must_change", !!patch.mustChange);
  }
  if (!sets.length) return publicUser(u);

  vals.push(id);
  const row = await db.one(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals);
  return publicUser(row);
}

async function setOwnPassword(id, newPassword) {
  const salt = createSalt();
  const row = await db.one(
    `UPDATE users SET password_hash = $1, password_salt = $2, must_change = FALSE
     WHERE id = $3 RETURNING *`,
    [hashPassword(newPassword, salt), salt, id]);
  return publicUser(row);
}

async function authenticate(email, password) {
  const u = await findByEmail(email);
  if (!u || u.disabled) return null;
  if (!verifyPassword(password, u.password_salt, u.password_hash)) return null;
  return u;
}

// ── middleware ───────────────────────────────────────────
async function attachUser(req, res, next) {
  try {
    const sess = verifyToken(parseCookies(req)[COOKIE]);
    if (!sess) { req.user = null; return next(); }
    const u = await findById(sess.uid);
    req.user = u && !u.disabled ? publicUser(u) : null;
  } catch (e) {
    req.user = null;
  }
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

// ── seeding ──────────────────────────────────────────────
/** Accounts defined in the SEED_ACCOUNTS env var (JSON array). */
function parseSeedAccounts() {
  const raw = process.env.SEED_ACCOUNTS;
  if (!raw) return null;
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((a) => a && a.email && a.password && a.role) : null;
  } catch (_) { return null; }
}

/** Create accounts on first run if the users table is empty. */
async function seedIfEmpty(adminEmail) {
  const [{ count }] = await db.query("SELECT COUNT(*)::int AS count FROM users");
  if (count > 0) return null;

  const seedList = parseSeedAccounts();
  if (seedList && seedList.length) {
    for (const acc of seedList) {
      try { await createUser({ ...acc, mustChange: false }); }
      catch (e) { console.warn(" ! could not seed " + acc.email + ": " + e.message); }
    }
    console.log(`\n * seeded ${seedList.length} account(s) from SEED_ACCOUNTS\n`);
    return null;
  }

  const temp = crypto.randomBytes(6).toString("base64url");
  await createUser({ email: adminEmail, name: "Accounting Admin", role: "admin",
                     password: temp, mustChange: true });
  console.log("\n ┌─────────────────────────────────────────────");
  console.log(" │  Seeded first admin account:");
  console.log(" │    email:    " + adminEmail);
  console.log(" │    password: " + temp + "   (change it after first login)");
  console.log(" └─────────────────────────────────────────────\n");
  return temp;
}

module.exports = {
  ROLES, initSecret, attachUser, requireAuth, requireRole, setSession, clearSession,
  authenticate, publicUser, createUser, updateUser, setOwnPassword, listUsers,
  findById, findByEmail, seedIfEmpty,
};
