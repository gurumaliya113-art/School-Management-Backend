'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { one, all, q, audit } = require('./db');
const { MODULES } = require('./schema');

const COOKIE = 'sms_sid';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const MAX_FAILS = 5;
const LOCK_MIN = 15;
const LEVEL = { none: 0, view: 1, edit: 2 };

const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieStr(value, maxAgeSec) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${secure}`;
}

function passwordProblem(p) {
  if (typeof p !== 'string' || p.length < 8) return 'Password must be at least 8 characters.';
  if (p.length > 128) return 'Password is too long.';
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return 'Password must contain letters and numbers.';
  return null;
}

async function permsFor(role) {
  if (role === 'admin') return Object.fromEntries(MODULES.map((m) => [m.key, 'edit']));
  const rows = await all('SELECT module, level FROM role_perms WHERE role=$1', [role]);
  const p = Object.fromEntries(MODULES.map((m) => [m.key, 'none']));
  for (const r of rows) if (r.module in p) p[r.module] = r.level;
  return p;
}

async function login(req, res) {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Username and password required' });
  const u = await one('SELECT * FROM app_users WHERE lower(username)=lower($1)', [username.trim()]);
  const fail = async (msg) => { await audit(req, 'login_failed', 'auth', u?.id, { username }); return res.status(401).json({ error: msg || 'Invalid username or password' }); };

  if (!u) { await bcrypt.compare(password, DUMMY_HASH); return fail(); } // same timing as a real check
  if (u.locked_until && new Date(u.locked_until) > new Date()) return fail(`Account locked after too many attempts. Try again after ${LOCK_MIN} minutes.`);
  if (u.status !== 'Active') return fail('Account is suspended. Contact administrator.');
  if (!(await bcrypt.compare(password, u.pass_hash))) {
    const n = u.failed_count + 1;
    await q('UPDATE app_users SET failed_count=$1, locked_until=$2 WHERE id=$3',
      [n >= MAX_FAILS ? 0 : n, n >= MAX_FAILS ? new Date(Date.now() + LOCK_MIN * 60000) : null, u.id]);
    return fail();
  }
  await q('UPDATE app_users SET failed_count=0, locked_until=NULL, last_login=now() WHERE id=$1', [u.id]);
  const token = crypto.randomBytes(32).toString('hex');
  await q('INSERT INTO app_sessions(token_hash, user_id, expires, ip) VALUES ($1,$2,$3,$4)',
    [sha(token), u.id, new Date(Date.now() + SESSION_HOURS * 3600000), req.ip]);
  await q('DELETE FROM app_sessions WHERE expires < now()');
  req.user = u;
  await audit(req, 'login', 'auth', u.id);
  res.setHeader('Set-Cookie', cookieStr(token, SESSION_HOURS * 3600));
  res.json({ ok: true, must_change: u.must_change });
}

async function logout(req, res) {
  const t = parseCookies(req.headers.cookie)[COOKIE];
  if (t) await q('DELETE FROM app_sessions WHERE token_hash=$1', [sha(t)]);
  res.setHeader('Set-Cookie', cookieStr('', 0));
  res.json({ ok: true });
}

// Loads req.user + req.perms. Rejects if not logged in.
async function requireAuth(req, res, next) {
  try {
    const t = parseCookies(req.headers.cookie)[COOKIE];
    if (!t) return res.status(401).json({ error: 'Not logged in' });
    const u = await one(`SELECT u.id, u.username, u.full_name, u.role, u.status, u.must_change
      FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires > now()`, [sha(t)]);
    if (!u || u.status !== 'Active') return res.status(401).json({ error: 'Session expired. Please log in again.' });
    req.user = u;
    req.perms = await permsFor(u.role);
    // Until the default/reset password is changed, only allow auth endpoints.
    if (u.must_change && !req.path.startsWith('/auth/')) return res.status(403).json({ error: 'Please change your password first', must_change: true });
    next();
  } catch (e) { next(e); }
}

const can = (req, module, level = 'view') => LEVEL[req.perms?.[module] || 'none'] >= LEVEL[level];

function need(module, level = 'view') {
  return (req, res, next) => (can(req, module, level) ? next() : res.status(403).json({ error: 'You do not have access to this section' }));
}

async function changePassword(req, res) {
  const { current, next: np } = req.body || {};
  const u = await one('SELECT pass_hash FROM app_users WHERE id=$1', [req.user.id]);
  if (!(await bcrypt.compare(String(current || ''), u.pass_hash))) return res.status(400).json({ error: 'Current password is wrong' });
  const prob = passwordProblem(np);
  if (prob) return res.status(400).json({ error: prob });
  if (np === current) return res.status(400).json({ error: 'New password must be different' });
  await q('UPDATE app_users SET pass_hash=$1, must_change=FALSE WHERE id=$2', [await bcrypt.hash(np, 12), req.user.id]);
  // Sign out all other sessions
  const t = parseCookies(req.headers.cookie)[COOKIE];
  await q('DELETE FROM app_sessions WHERE user_id=$1 AND token_hash<>$2', [req.user.id, sha(t || '')]);
  await audit(req, 'password_changed', 'auth', req.user.id);
  res.json({ ok: true });
}

async function ensureAdmin() {
  const n = (await one('SELECT count(*)::int AS n FROM app_users')).n;
  if (n > 0) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw || passwordProblem(pw)) {
    console.error('No users exist. Set ADMIN_PASSWORD (min 8 chars, letters + numbers) to create the first admin.');
    process.exit(1);
  }
  await q(`INSERT INTO app_users(username, full_name, role, pass_hash, must_change) VALUES ($1,'Administrator','admin',$2,TRUE)`,
    [username, await bcrypt.hash(pw, 12)]);
  console.log(`Created first admin user "${username}". You will be asked to change the password on first login.`);
}

module.exports = { login, logout, requireAuth, need, can, changePassword, ensureAdmin, permsFor, passwordProblem, LEVEL };
