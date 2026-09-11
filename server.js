'use strict';
// Ribak CRM server: serves the static app and a small JSON API backed by
// MySQL. One shared password gates everything under /api/leads.
//
// Configuration comes from environment variables (Hostinger → Environment
// variables):
//   DB_HOST, DB_PORT (3306), DB_NAME, DB_USER, DB_PASSWORD
//   CRM_PASSWORD      – the shared login password
//   SESSION_SECRET    – optional; random string used to sign session cookies
//   SESSION_DAYS      – optional; how long a login lasts (default 30)

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');

const PORT = Number(process.env.PORT) || 3000;
const {
  DB_HOST, DB_PORT = '3306', DB_NAME, DB_USER, DB_PASSWORD,
  CRM_PASSWORD, SESSION_SECRET, SESSION_DAYS = '30',
} = process.env;

const dbConfigured = Boolean(DB_HOST && DB_NAME && DB_USER && typeof DB_PASSWORD === 'string');
const authConfigured = Boolean(CRM_PASSWORD);
const COOKIE = 'ribak_session';
const SESSION_TTL = Math.max(1, Number(SESSION_DAYS) || 30) * 86400;
const secret = SESSION_SECRET
  || crypto.createHash('sha256').update(`ribak-crm|${CRM_PASSWORD || ''}|${DB_PASSWORD || ''}`).digest('hex');

// ---- database ---------------------------------------------------------
const pool = dbConfigured ? mysql.createPool({
  host: DB_HOST, port: Number(DB_PORT) || 3306,
  user: DB_USER, password: DB_PASSWORD, database: DB_NAME,
  waitForConnections: true, connectionLimit: 4, connectTimeout: 10000,
  charset: 'utf8mb4_unicode_ci',
}) : null;

let schemaReady = false;
let lastDbError = null;

async function ensureSchema() {
  if (!pool) { const e = new Error('db_not_configured'); e.code = 'db_not_configured'; throw e; }
  if (schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS leads (
      id VARCHAR(40) NOT NULL PRIMARY KEY,
      data MEDIUMTEXT NOT NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      KEY idx_updated (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS settings (
      k VARCHAR(64) NOT NULL PRIMARY KEY,
      v MEDIUMTEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  schemaReady = true;
  lastDbError = null;
}

async function dbStatus() {
  if (!pool) return { ok: false, error: 'db_not_configured' };
  try { await ensureSchema(); return { ok: true }; }
  catch (e) { lastDbError = e.code || e.message; return { ok: false, error: lastDbError }; }
}

const toSqlDate = iso => {
  const d = iso ? new Date(iso) : new Date();
  return (isNaN(d) ? new Date() : d).toISOString().slice(0, 23).replace('T', ' ');
};

// ---- sessions (HMAC-signed cookie, no server state) -------------------
const b64 = s => Buffer.from(s).toString('base64url');
const mac = body => crypto.createHmac('sha256', secret).update(body).digest('base64url');

function sign(payload) {
  const body = b64(JSON.stringify(payload));
  return `${body}.${mac(body)}`;
}
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = mac(body);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp && p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}
function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
const isAuthed = req => Boolean(verify(getCookie(req, COOKIE)));
const isSecure = req => req.secure || req.headers['x-forwarded-proto'] === 'https';

function setSession(req, res) {
  const token = sign({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL, v: 1 });
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}${isSecure(req) ? '; Secure' : ''}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const passwordMatches = input => authConfigured && crypto.timingSafeEqual(sha(input), sha(CRM_PASSWORD));

// Brute-force brake: 10 failed attempts per IP → 15 minute pause.
const attempts = new Map();
function tooManyAttempts(ip) {
  const a = attempts.get(ip);
  return a && a.count >= 10 && a.until > Date.now();
}
function recordFailure(ip) {
  const a = attempts.get(ip) || { count: 0, until: 0 };
  a.count += 1;
  if (a.count >= 10) a.until = Date.now() + 15 * 60 * 1000;
  attempts.set(ip, a);
}

// ---- app --------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);
const requireAuth = (req, res, next) => (isAuthed(req) ? next() : res.status(401).json({ error: 'unauthorized', code: 'unauthorized' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/session', wrap(async (req, res) => {
  const db = dbConfigured ? await dbStatus() : { ok: false, error: 'db_not_configured' };
  res.json({
    mode: 'remote',
    configured: dbConfigured && authConfigured,
    missing: [
      ...(dbConfigured ? [] : ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].filter(k => !process.env[k] && !(k === 'DB_PASSWORD' && typeof DB_PASSWORD === 'string'))),
      ...(authConfigured ? [] : ['CRM_PASSWORD']),
    ],
    dbOk: db.ok,
    dbError: db.ok ? null : db.error,
    authenticated: isAuthed(req),
  });
}));

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!authConfigured) return res.status(503).json({ error: 'password_not_set', code: 'password_not_set' });
  if (tooManyAttempts(ip)) return res.status(429).json({ error: 'too_many_attempts', code: 'too_many_attempts' });
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!passwordMatches(password)) { recordFailure(ip); return res.status(401).json({ error: 'wrong_password', code: 'wrong_password' }); }
  attempts.delete(ip);
  setSession(req, res);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

const leadsRouter = express.Router();
leadsRouter.use(requireAuth);
leadsRouter.use(wrap(async (req, res, next) => { await ensureSchema(); next(); }));

leadsRouter.get('/leads', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT data FROM leads ORDER BY created_at DESC');
  const [srows] = await pool.query('SELECT k, v FROM settings');
  const settings = {};
  for (const r of srows) { try { settings[r.k] = JSON.parse(r.v); } catch { settings[r.k] = r.v; } }
  const leads = [];
  for (const r of rows) { try { leads.push(JSON.parse(r.data)); } catch { /* skip corrupt row */ } }
  res.json({ leads, settings });
}));

const validLead = l => l && typeof l === 'object' && typeof l.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(l.id);

leadsRouter.put('/leads/:id', wrap(async (req, res) => {
  const lead = req.body;
  if (!validLead(lead) || lead.id !== req.params.id) return res.status(400).json({ error: 'bad_lead', code: 'bad_lead' });
  const data = JSON.stringify(lead);
  await pool.query(
    'INSERT INTO leads (id, data, created_at, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at)',
    [lead.id, data, toSqlDate(lead.createdAt), toSqlDate(lead.updatedAt)],
  );
  res.json({ ok: true });
}));

leadsRouter.delete('/leads/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM leads WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// Replace everything (import, sample data, clear all).
leadsRouter.put('/leads', wrap(async (req, res) => {
  const leads = Array.isArray(req.body?.leads) ? req.body.leads : null;
  if (!leads || !leads.every(validLead)) return res.status(400).json({ error: 'bad_leads', code: 'bad_leads' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM leads');
    for (let i = 0; i < leads.length; i += 100) {
      const chunk = leads.slice(i, i + 100);
      await conn.query(
        'INSERT INTO leads (id, data, created_at, updated_at) VALUES ?',
        [chunk.map(l => [l.id, JSON.stringify(l), toSqlDate(l.createdAt), toSqlDate(l.updatedAt)])],
      );
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; }
  finally { conn.release(); }
  res.json({ ok: true, count: leads.length });
}));

leadsRouter.put('/settings', wrap(async (req, res) => {
  const settings = req.body && typeof req.body === 'object' ? req.body : {};
  const entries = Object.entries(settings).filter(([k]) => /^[A-Za-z0-9_]{1,64}$/.test(k));
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM settings');
    if (entries.length) await conn.query('INSERT INTO settings (k, v) VALUES ?', [entries.map(([k, v]) => [k, JSON.stringify(v)])]);
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; }
  finally { conn.release(); }
  res.json({ ok: true });
}));

app.use('/api', leadsRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', code: 'not_found' }));

// ---- static app -------------------------------------------------------
const PRIVATE = /^\/(server\.js|package(-lock)?\.json|node_modules|\.git|\.env|api)(\/|$)/;
app.use((req, res, next) => (PRIVATE.test(req.path) ? res.status(404).end() : next()));
app.use(express.static(__dirname, { index: 'index.html', etag: true, maxAge: 0 }));

// ---- errors -----------------------------------------------------------
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json', code: 'bad_json' });
  const code = err.code || 'server_error';
  console.error(`[api] ${req.method} ${req.path} → ${code}: ${err.message}`);
  res.status(code === 'db_not_configured' ? 503 : 500).json({ error: code, code, message: err.sqlMessage ? err.code : err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Ribak CRM listening on ${PORT} · db ${dbConfigured ? 'configured' : 'NOT configured'} · password ${authConfigured ? 'set' : 'NOT set'}`);
});
