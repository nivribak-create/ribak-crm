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
//   WEBHOOK_SECRET    – optional; enables POST /api/inbound/lead for
//                       automations (ManyChat, a website form, Make, n8n…)
//                       that push leads in. Several keys, comma separated,
//                       so one sender can be cut off without the others.
//   MAIL_USER, MAIL_PASS – optional; a mailbox that sends an email whenever a
//                       lead comes in (for Gmail: the address and an "app
//                       password"). MAIL_TO (default: MAIL_USER) is who gets
//                       it; MAIL_HOST / MAIL_PORT default to Gmail's.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');

const PORT = Number(process.env.PORT) || 3000;
const {
  DB_HOST, DB_PORT = '3306', DB_NAME, DB_USER, DB_PASSWORD,
  CRM_PASSWORD, SESSION_SECRET, SESSION_DAYS = '30', WEBHOOK_SECRET,
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
  // The app saves `settings` whole, so anything the server alone must keep —
  // its notification keys, the devices that asked for notifications — lives
  // in a table of its own that no screen can read or overwrite.
  await pool.query(`CREATE TABLE IF NOT EXISTS server_kv (
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
app.use(express.json({
  limit: '8mb',
  // Meta signs the exact bytes it sent, so the signature can only be checked
  // against the raw body, not against the parsed JSON.
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

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

// Whether the lead email is set up, and a way to try it without waiting for a
// lead. Says what went wrong, never the password.
leadsRouter.get('/mail', (req, res) => res.json({
  configured: mailConfigured, library: Boolean(nodemailer),
  missing: ['MAIL_USER', 'MAIL_PASS'].filter(k => !cleanEnv(process.env[k])),
  ...mailState,
}));
leadsRouter.post('/mail/test', wrap(async (req, res) => {
  if (!mailer) return res.status(503).json({ ok: false, error: 'mail_not_configured', code: 'mail_not_configured' });
  try {
    await sendMail(leadMail(
      { name: 'ליד בדיקה', phone: '0500000000', source: 'אינסטגרם – ממומן', adId: '120253935192800236' },
      { notes: 'זה מייל בדיקה מה-CRM. לא נוצר ליד.' },
    ));
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'mail_failed', code: 'mail_failed', message: mailState.lastError });
  }
}));

// Notifications on a device: the page asks for the public key, hands back the
// browser's subscription, and can ask for a test.
leadsRouter.get('/push', wrap(async (req, res) => {
  if (!webpush) return res.json({ supported: false, devices: 0 });
  const subs = (await kvGet('push_subs')) || [];
  res.json({ supported: true, publicKey: (await vapidKeys()).publicKey, devices: subs.length, ...pushState });
}));
leadsRouter.post('/push/subscribe', wrap(async (req, res) => {
  if (!webpush) return res.status(503).json({ error: 'push_unavailable', code: 'push_unavailable' });
  const sub = cleanSubscription(req.body && req.body.subscription);
  if (!sub) return res.status(400).json({ error: 'bad_subscription', code: 'bad_subscription' });
  const subs = ((await kvGet('push_subs')) || []).filter(s => s.endpoint !== sub.endpoint);
  subs.push({ ...sub, addedAt: new Date().toISOString(), device: oneLine(req.get('user-agent')).slice(0, 160) });
  await kvSet('push_subs', subs.slice(-20));
  res.json({ ok: true, devices: Math.min(subs.length, 20) });
}));
leadsRouter.post('/push/unsubscribe', wrap(async (req, res) => {
  const endpoint = String((req.body && req.body.endpoint) || '');
  const subs = (await kvGet('push_subs')) || [];
  await kvSet('push_subs', subs.filter(s => s.endpoint !== endpoint));
  res.json({ ok: true });
}));
leadsRouter.post('/push/test', wrap(async (req, res) => {
  const out = await pushAll({ title: 'התראת בדיקה מה-CRM', body: 'ככה תיראה התראה על ליד חדש. לא נוצר ליד.', url: './', tag: 'test' });
  res.json({ ok: out.sent > 0, ...out, error: out.sent ? null : pushState.lastError });
}));

const validLead = l => l && typeof l === 'object' && typeof l.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(l.id);

leadsRouter.put('/leads/:id', wrap(async (req, res) => {
  const lead = req.body;
  if (!validLead(lead) || lead.id !== req.params.id) return res.status(400).json({ error: 'bad_lead', code: 'bad_lead' });
  // The app saves a lead whole, from the copy it loaded. If the customer
  // pressed a button on their link in the meantime, that answer exists only
  // here — so it is carried over rather than overwritten. Losing an order is
  // bad; losing a "stop messaging me" is worse.
  const [prev] = await pool.query('SELECT data FROM leads WHERE id = ?', [lead.id]);
  if (prev.length) {
    try {
      const stored = JSON.parse(prev[0].data);
      const key = e => `${e.t}|${e.type}`;
      const have = new Set((lead.events || []).map(key));
      const missed = (stored.events || []).filter(e => e.via === 'link' && !have.has(key(e)));
      if (missed.length) {
        lead.events = [...(lead.events || []), ...missed].sort((a, b) => (a.t < b.t ? -1 : 1));
        if (missed.some(e => e.type === 'optout')) lead.noMarketing = true;
      }
    } catch { /* an unreadable old row has nothing to carry over */ }
  }
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

// ---- inbound leads from automations --------------------------------------
// POST /api/inbound/lead  (header X-Webhook-Key: <WEBHOOK_SECRET>, or ?key=)
// Body: { name?, phone?, text?, source?, notes?, username?, ad_id?,
//         ad_name?, adset_name?, campaign_name? }
// The phone may arrive in `phone` or anywhere inside `text` (an Instagram
// DM, say). A lead that already exists with that phone gets a note instead
// of a duplicate.
const PHONE_RE = /(?:\+?972[\s-]?|0)(5\d)[\s-]?(\d{3})[\s-]?(\d{4})/;
function extractPhone(...candidates) {
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const m = c.match(PHONE_RE);
    if (m) return `0${m[1]}${m[2]}${m[3]}`;
  }
  return null;
}
// More than one automation pushes leads in — ManyChat, the website form, a
// contractor's script — so WEBHOOK_SECRET holds a key per sender, separated
// by commas. Each can be replaced without taking the others down.
const WEBHOOK_KEYS = String(WEBHOOK_SECRET || '').split(',').map(k => k.trim()).filter(Boolean);
const webhookAuthed = req => {
  const given = String(req.get('x-webhook-key') || req.query.key || '');
  if (!given) return false;
  // Hashed first so every key is compared at the same length.
  const g = sha(given);
  let ok = false;
  for (const k of WEBHOOK_KEYS) if (crypto.timingSafeEqual(g, sha(k))) ok = true;
  return ok;
};
const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex').slice(0, 6);

// Keep in step with SOURCES in js/model.js: an unknown string would show up
// in the app as a source of its own and split the numbers.
const INBOUND_SOURCES = ['אינסטגרם – ממומן', 'אינסטגרם – משפיען', 'המלצה', 'אתר', 'וואטסאפ', 'אחר', 'לא ידוע'];
const DEFAULT_SOURCE = 'אינסטגרם – ממומן';
const INFLUENCER_SOURCE = 'אינסטגרם – משפיען';

// An influencer's link carries a short ref ("dana_fit") while the same
// person may be filed in the app under a name or a handle. Matching them up
// is what keeps one collaboration from being counted as two.
async function canonicalInfluencer(raw) {
  const given = raw.replace(/^@/, '').toLowerCase();
  if (!given) return '';
  try {
    const [rows] = await pool.query("SELECT v FROM settings WHERE k = 'influencers'");
    const list = rows.length ? JSON.parse(rows[0].v) : [];
    for (const i of Array.isArray(list) ? list : []) {
      const handle = String(i.handle || '').replace(/^@/, '').toLowerCase();
      const ref = String(i.ref || '').replace(/^@/, '').toLowerCase();
      const name = String(i.name || '').trim().toLowerCase();
      if ((handle && handle === given) || (ref && ref === given) || (name && name === given)) {
        return i.handle ? `@${i.handle}` : i.name;
      }
    }
  } catch { /* an unreadable list is no reason to drop the attribution */ }
  // A latin slug came out of a URL, so it is a handle; a Hebrew name is a name.
  return /^[A-Za-z0-9._-]+$/.test(given) ? `@${given}` : raw;
}

// ---- an email when a lead comes in -----------------------------------------
// A lead that waits an hour is half lost, and nobody keeps a CRM tab open all
// day. The mailbox is the owner's own, so nothing is sent to anyone else.
// nodemailer is loaded softly: a failed install must not take the CRM down.
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch { /* mail simply stays off */ }
// A value pasted into a hosting panel picks up a trailing space or a pair of
// quotes more often than anything else, and then it is "wrong" while looking
// exactly right to the eye.
const cleanEnv = v => String(v || '').trim().replace(/^["']+|["']+$/g, '').trim();
const MAIL_USER = cleanEnv(process.env.MAIL_USER);
const MAIL_HOST = cleanEnv(process.env.MAIL_HOST) || 'smtp.gmail.com';
const MAIL_PORT = Number(process.env.MAIL_PORT) || 465;
// Google shows an app password in four groups; the spaces are not part of it.
const MAIL_PASS = cleanEnv(process.env.MAIL_PASS).replace(/\s+/g, '');
const MAIL_TO = cleanEnv(process.env.MAIL_TO) || MAIL_USER;
const CRM_URL = (cleanEnv(process.env.CRM_URL) || 'https://blanchedalmond-yak-848858.hostingersite.com').replace(/\/$/, '');
const mailConfigured = Boolean(nodemailer && MAIL_USER && MAIL_PASS && MAIL_TO);
const mailer = mailConfigured ? nodemailer.createTransport({
  host: MAIL_HOST, port: MAIL_PORT, secure: MAIL_PORT === 465,
  auth: { user: MAIL_USER, pass: MAIL_PASS },
  connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
}) : null;
const mailState = { sent: 0, lastSentAt: null, lastError: null, lastErrorAt: null };
// A flood of junk through the public form must not burn the mailbox's daily
// allowance, or get it locked.
const MAIL_LIMIT = 40, MAIL_WINDOW = 60 * 60 * 1000;
let mailTimes = [];

// Keep in step with TEST_ADS and AD_VIDEOS in js/model.js.
const MAIL_ADS = {
  '120253935192800236': 'B1 · דף נחיתה · "הכל מוכן לי" · מיקה שיין',
  '120253935180300236': 'B2 · דף נחיתה · "כל האוכל לכל השבוע" · מיקה שיין',
  '120253935195690236': 'B3 · דף נחיתה · "למדוד חלבון וקלוריות" · גליה סמסון',
  '120253935197110236': 'B4 · דף נחיתה · "ארוחות מאוזנות" · גליה סמסון',
  '120253961397240236': 'B5 · דף נחיתה · "חוסך זמן וכאב ראש" · מיקה שיין',
  '120253935152190236': 'A1 · DM · "הכל מוכן לי" · מיקה שיין',
  '120253935157190236': 'A2 · DM · "כל האוכל לכל השבוע" · מיקה שיין',
  '120253935157530236': 'A3 · DM · "למדוד חלבון וקלוריות" · גליה סמסון',
  '120253935158430236': 'A4 · DM · "ארוחות מאוזנות" · גליה סמסון',
};
const mailEsc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oneLine = v => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();

function leadMail(lead, o = {}) {
  const name = oneLine(o.name || lead.name) || 'בלי שם';
  const phone = String(lead.phone || '').replace(/\D/g, '');
  const adId = o.adId || lead.adId || '';
  const own = lead.adId === adId && lead.adNames ? oneLine(lead.adNames.ad) : '';
  const ad = adId ? (MAIL_ADS[adId] || own || `לא מזוהה (${adId})`) : '';
  const code = ad && MAIL_ADS[adId] ? ad.split(' · ').slice(0, 2).join(' ') : '';
  const when = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const rows = [
    ['שם', name],
    ...(o.repeat && oneLine(lead.name) && oneLine(lead.name) !== name ? [['רשום ב-CRM בשם', oneLine(lead.name)]] : []),
    ['טלפון', phone],
    ['מקור', oneLine(o.source || lead.source)],
    ...(ad ? [['מודעה', ad]] : []),
    ...(lead.influencer || o.influencer ? [['משפיען', oneLine(o.influencer || lead.influencer)]] : []),
    ...(o.text ? [['הודעה', oneLine(o.text).slice(0, 300)]] : []),
    ...(o.username ? [['אינסטגרם', `@${oneLine(o.username)}`]] : []),
    ...(o.notes ? [['הערות', oneLine(o.notes).slice(0, 300)]] : []),
    ...(o.consentNote ? [['דיוור', o.consentNote]] : []),
    ...(o.repeat ? [['מצב ב-CRM', lead.status === 'lost' ? 'סומן בעבר "לא רלוונטי"' : 'כבר קיים במערכת']] : []),
    ['נכנס', when],
  ];
  const wa = /^05\d{8}$/.test(phone) ? `https://wa.me/972${phone.slice(1)}` : '';
  const crm = lead.id ? `${CRM_URL}/#lead/${lead.id}` : CRM_URL;
  const subject = oneLine(`${o.repeat ? 'פנייה חוזרת' : 'ליד חדש'}: ${name}${code ? ` · ${code}` : ''}`).slice(0, 150);
  const text = [
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    ...(wa ? [`וואטסאפ: ${wa}`] : []),
    `לפתיחת הכרטיס ב-CRM: ${crm}`,
  ].join('\n');
  const btn = (href, label, bg) => `<a href="${mailEsc(href)}" style="display:inline-block;margin:0 0 8px 8px;padding:11px 18px;border-radius:8px;background:${bg};color:#ffffff;text-decoration:none;font-weight:bold">${label}</a>`;
  const html = `<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1c1c1c;text-align:right">
<p style="margin:0 0 14px;font-size:20px;font-weight:bold">${o.repeat ? 'פנייה חוזרת' : 'ליד חדש'}: ${mailEsc(name)}</p>
<table dir="rtl" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 18px">
${rows.map(([k, v]) => `<tr><td style="padding:5px 0 5px 16px;color:#6b6b6b;white-space:nowrap;vertical-align:top">${mailEsc(k)}</td><td style="padding:5px 0;vertical-align:top">${k === 'טלפון' && v ? `<a href="tel:${mailEsc(v)}" style="color:#1c1c1c">${mailEsc(v)}</a>` : mailEsc(v)}</td></tr>`).join('\n')}
</table>
<p style="margin:0">${wa ? btn(wa, 'פתיחת וואטסאפ', '#1f8f4e') : ''}${phone ? btn(`tel:${phone}`, 'חיוג', '#2c4a7c') : ''}${btn(crm, 'פתיחת הכרטיס ב-CRM', '#444444')}</p>
</div>`;
  return { subject, text, html };
}

async function sendMail(msg) {
  if (!mailer) { const e = new Error('mail_not_configured'); e.code = 'mail_not_configured'; throw e; }
  try {
    await mailer.sendMail({ from: { name: 'Ribak CRM', address: MAIL_USER }, to: MAIL_TO, ...msg });
    mailState.sent += 1; mailState.lastSentAt = new Date().toISOString(); mailState.lastError = null; mailState.lastErrorAt = null;
  } catch (e) {
    // The code and the server's own short answer say what is wrong (a bad
    // password, a blocked port) without printing the password.
    mailState.lastError = `${e.code || 'error'}${e.responseCode ? ' ' + e.responseCode : ''}: ${oneLine(e.response || e.message).slice(0, 200)}`;
    mailState.lastErrorAt = new Date().toISOString();
    throw e;
  }
}

// ---- a notification on the phone when a lead comes in ----------------------
// The simpler of the two: nothing to set up in a hosting panel. A device that
// has the CRM open asks once for permission, and from then on the browser
// itself shows the notification, with the CRM closed. The server's key pair
// is made on first use and kept in the database.
let webpush = null;
try { webpush = require('web-push'); } catch { /* notifications simply stay off */ }
async function kvGet(k) {
  const [rows] = await pool.query('SELECT v FROM server_kv WHERE k = ?', [k]);
  if (!rows.length) return null;
  try { return JSON.parse(rows[0].v); } catch { return null; }
}
const kvSet = (k, v) => pool.query('INSERT INTO server_kv (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, JSON.stringify(v)]);
let vapid = null;
async function vapidKeys() {
  if (vapid) return vapid;
  let v = await kvGet('vapid');
  if (!v || !v.publicKey || !v.privateKey) {
    // Two requests can get here together; whichever insert lands first wins
    // and both read the same pair back.
    await pool.query('INSERT IGNORE INTO server_kv (k, v) VALUES (?, ?)', ['vapid', JSON.stringify(webpush.generateVAPIDKeys())]);
    v = await kvGet('vapid');
  }
  vapid = v;
  return v;
}
// The server posts to whatever address a subscription names, so only the
// browsers' own push services are accepted.
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
function cleanSubscription(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const endpoint = String(sub.endpoint || '');
  const p256dh = String((sub.keys && sub.keys.p256dh) || '');
  const auth = String((sub.keys && sub.keys.auth) || '');
  if (endpoint.length > 1000 || !/^[A-Za-z0-9_-]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,100}$/.test(auth)) return null;
  let u; try { u = new URL(endpoint); } catch { return null; }
  if (u.protocol !== 'https:' || !PUSH_HOSTS.test(u.hostname)) return null;
  return { endpoint, keys: { p256dh, auth } };
}
const pushState = { sent: 0, lastSentAt: null, lastError: null };
async function pushAll(payload) {
  if (!webpush || !pool) return { devices: 0, sent: 0 };
  const subs = (await kvGet('push_subs')) || [];
  if (!subs.length) return { devices: 0, sent: 0 };
  const keys = await vapidKeys();
  const gone = new Set();
  let sent = 0, failed = '';
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload), {
        vapidDetails: { subject: CRM_URL, publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: 12 * 3600, urgency: 'high', timeout: 15000,
      });
      sent += 1;
    } catch (e) {
      // 404 and 410 are the push service saying this device unsubscribed.
      if (e.statusCode === 404 || e.statusCode === 410) gone.add(s.endpoint);
      else failed = `${e.statusCode || e.code || 'error'}: ${oneLine(e.body || e.message).slice(0, 160)}`;
    }
  }));
  if (gone.size) {
    const now = (await kvGet('push_subs')) || [];
    await kvSet('push_subs', now.filter(s => !gone.has(s.endpoint)));
  }
  if (sent) { pushState.sent += sent; pushState.lastSentAt = new Date().toISOString(); }
  pushState.lastError = failed || null;
  return { devices: subs.length - gone.size, sent };
}
function leadPush(lead, o = {}) {
  const name = oneLine(o.name || lead.name) || 'בלי שם';
  const adId = o.adId || lead.adId || '';
  const own = lead.adId === adId && lead.adNames ? oneLine(lead.adNames.ad) : '';
  const ad = adId ? (MAIL_ADS[adId] ? MAIL_ADS[adId].split(' · ').slice(0, 2).join(' ') : own || 'מודעה לא מזוהה') : '';
  return {
    title: `${o.repeat ? 'פנייה חוזרת' : 'ליד חדש'}: ${name}`.slice(0, 80),
    body: [ad || oneLine(o.source || lead.source), String(lead.phone || '')].filter(Boolean).join(' · ').slice(0, 120),
    url: lead.id ? `./#lead/${lead.id}` : './',
    tag: `lead-${lead.id || 'x'}`,
  };
}

// Never awaited by the caller: a lead is saved whether or not anyone is told.
function notifyLead(lead, o) {
  if (!mailer && !webpush) return;
  const now = Date.now();
  mailTimes = mailTimes.filter(t => t > now - MAIL_WINDOW);
  if (mailTimes.length >= MAIL_LIMIT) { console.warn(`lead notification skipped (more than ${MAIL_LIMIT} in an hour): ${lead.id}`); return; }
  mailTimes.push(now);
  if (mailer) sendMail(leadMail(lead, o)).catch(e => console.error(`lead mail failed for ${lead.id}: ${mailState.lastError || e.message}`));
  pushAll(leadPush(lead, o)).catch(e => console.error(`lead push failed for ${lead.id}: ${e.message}`));
}

// One place that turns "someone left their details" into a lead, so every
// sender — a bot, a website form, a Meta lead form — behaves the same.
async function ingestLead(b) {
  const text = String(b.text || b.message || '').trim().slice(0, 1000);
  const phone = extractPhone(b.phone, text);
  // Most DMs are just conversation, so an automation can forward all of them
  // and let this decide. Nothing to do is a success, not an error — otherwise
  // the automation's log fills with failures and hides the real ones.
  if (!phone) return { status: 200, body: { ok: true, created: false, reason: 'no_phone' } };
  const username = String(b.username || b.ig_username || '').trim().replace(/^@/, '');
  const name = String(b.name || b.full_name || '').trim() || (username ? `@${username}` : 'ליד מאינסטגרם');
  // Which influencer sent them is the whole point of a gateway link, so it
  // is read from `influencer` or from the link's own `ref`.
  const influencer = await canonicalInfluencer(
    String(b.influencer || b.ref || '').trim().replace(/\s+/g, ' ').slice(0, 60),
  );
  // A click-to-DM ad hands the conversation the id of the ad it came from,
  // which is the only way to tell which of eleven creatives earned a lead.
  const adId = String(b.ad_id || b.adId || '').replace(/[^0-9]/g, '').slice(0, 32);
  // A sender that knows what the ad is called says so, and then an ad added
  // after the table in js/model.js was written still arrives with a name
  // instead of a bare number.
  const adText = v => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const adNames = adId && adText(b.ad_name || b.adName)
    ? { ad: adText(b.ad_name || b.adName), adset: adText(b.adset_name), campaign: adText(b.campaign_name) } : null;
  // Meta delivers a webhook at least once, so the same form submission can
  // arrive twice; its own id is what tells the two apart from a real repeat.
  const leadgenId = String(b.leadgen_id || '').replace(/[^0-9]/g, '').slice(0, 32);
  const asked = String(b.source || '').trim();
  const source = influencer ? INFLUENCER_SOURCE
    : INBOUND_SOURCES.includes(asked) ? asked
      : adId ? 'אינסטגרם – ממומן' : DEFAULT_SOURCE;
  const now = new Date().toISOString();
  const noteText = [text ? `הודעה: "${text.slice(0, 300)}"` : '', username ? `אינסטגרם: @${username}` : ''].filter(Boolean).join(' · ');
  // Whether someone agreed to marketing messages is the kind of thing you
  // have to be able to prove later, so it goes on the timeline with its own
  // timestamp rather than into a field that an edit could overwrite.
  const consent = b.consent === undefined || b.consent === null || b.consent === ''
    ? null : [true, 'true', 1, '1', 'yes', 'on', 'כן'].includes(b.consent);
  const consentNote = consent === null ? null
    : consent ? 'אישר/ה קבלת תכנים שיווקיים' : 'לא סימן/ה הסכמה לתכנים שיווקיים – פנייה בלבד';

  // dedupe by phone – scan is fine at this scale
  const [rows] = await pool.query('SELECT id, data FROM leads');
  let existing = null;
  for (const r of rows) {
    try {
      const l = JSON.parse(r.data);
      if (leadgenId && Array.isArray(l.leadgenIds) && l.leadgenIds.includes(leadgenId)) {
        return { status: 200, body: { ok: true, created: false, duplicate: true, id: l.id } };
      }
      if (!existing && String(l.phone || '').replace(/\D/g, '') === phone) existing = l;
    } catch { /* skip */ }
  }
  if (existing) {
    if (leadgenId) existing.leadgenIds = [...(existing.leadgenIds || []), leadgenId].slice(-20);
    // Whoever brought them in first keeps the credit; a second influencer's
    // link only earns a line on the timeline.
    const credited = String(existing.influencer || '').trim();
    const stolen = influencer && credited && credited !== influencer;
    if (influencer && !credited) { existing.influencer = influencer; existing.source = INFLUENCER_SOURCE; }
    if (adId && !existing.adId) existing.adId = adId;
    if (adNames && existing.adId === adId && !existing.adNames) existing.adNames = adNames;
    existing.events = [
      ...(existing.events || []),
      { t: now, type: 'note', text: `פנייה חוזרת (${source})${influencer ? ' · ' + influencer : ''}${noteText ? ' · ' + noteText : ''}` },
      ...(stolen ? [{ t: now, type: 'note', text: `הגיע גם מהלינק של ${influencer} – הקרדיט נשאר אצל ${credited}` }] : []),
      ...(consentNote ? [{ t: now, type: 'note', text: consentNote }] : []),
    ];
    existing.updatedAt = now;
    if (existing.status === 'active' && !existing.nextAt) existing.nextAt = now.slice(0, 10);
    await pool.query('UPDATE leads SET data = ?, updated_at = ? WHERE id = ?', [JSON.stringify(existing), toSqlDate(now), existing.id]);
    notifyLead(existing, { repeat: true, name: String(b.name || b.full_name || '').trim(), source, adId, influencer, text, username, consentNote });
    return { status: 200, body: { ok: true, created: false, id: existing.id } };
  }
  const lead = {
    id: newId(), name, phone, source, influencer, adId,
    ...(adNames ? { adNames } : {}),
    leadgenIds: leadgenId ? [leadgenId] : [],
    // A form behind an influencer's link: a cold lead, counted apart from
    // the people who came asking about the food.
    via: influencer ? 'magnet' : '',
    notes: String(b.notes || '').trim().slice(0, 500) || (username ? `@${username}` : ''),
    createdAt: now, updatedAt: now,
    stage: 'new', status: 'active', lostReason: null, lostAt: null,
    nextAt: now.slice(0, 10), attempts: 0,
    events: [
      { t: now, type: 'created', stage: 'new' },
      ...(noteText ? [{ t: now, type: 'note', text: noteText }] : []),
      ...(consentNote ? [{ t: now, type: 'note', text: consentNote }] : []),
    ],
  };
  await pool.query('INSERT INTO leads (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)', [lead.id, JSON.stringify(lead), toSqlDate(now), toSqlDate(now)]);
  notifyLead(lead, { text, username, consentNote, notes: lead.notes && lead.notes !== `@${username}` ? lead.notes : '' });
  return { status: 201, body: { ok: true, created: true, id: lead.id } };
}

app.post('/api/inbound/lead', wrap(async (req, res) => {
  if (!WEBHOOK_KEYS.length) return res.status(503).json({ error: 'webhook_not_configured', code: 'webhook_not_configured' });
  if (!webhookAuthed(req)) return res.status(401).json({ error: 'unauthorized', code: 'unauthorized' });
  await ensureSchema();
  const out = await ingestLead(req.body && typeof req.body === 'object' ? req.body : {});
  res.status(out.status).json(out.body);
}));

// ---- the landing page's own form -------------------------------------------
// POST /api/public/lead   Body: { name, phone, consent?, ad_id?, ref?, notes? }
// A form in a browser cannot keep a secret, so this door takes no key. What
// it has instead: it accepts only a name and an Israeli mobile, it can only
// ever add a lead (never read one back), a hidden field catches the bots that
// fill every input, and one address gets a handful of tries an hour.
// FORM_ORIGINS (optional, comma-separated) names the sites allowed to post
// from a browser; left unset, any site may.
const FORM_ORIGINS = String(process.env.FORM_ORIGINS || '').split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean);
const formHits = new Map();
const FORM_LIMIT = 8, FORM_WINDOW = 60 * 60 * 1000;
function formAllowed(ip) {
  const now = Date.now();
  if (formHits.size > 5000) for (const [k, v] of formHits) if (v.until < now) formHits.delete(k);
  const h = formHits.get(ip);
  if (!h || h.until < now) { formHits.set(ip, { count: 1, until: now + FORM_WINDOW }); return true; }
  h.count += 1;
  return h.count <= FORM_LIMIT;
}
function formCors(req, res) {
  const origin = String(req.get('origin') || '').replace(/\/$/, '');
  const ok = !FORM_ORIGINS.length || FORM_ORIGINS.includes(origin);
  if (origin && ok) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  return ok;
}
app.options('/api/public/lead', (req, res) => { formCors(req, res); res.status(204).end(); });
app.post('/api/public/lead', wrap(async (req, res) => {
  if (!formCors(req, res)) return res.status(403).json({ error: 'origin_not_allowed', code: 'origin_not_allowed' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  // A person never sees this field; answering as if it worked gives a bot
  // nothing to learn from. It is deliberately not called "company": a
  // browser's autofill fills a field with that name from the visitor's saved
  // details, and a real lead was then thrown away as a bot.
  if (String(b.hp || '').trim()) return res.json({ ok: true });
  if (!formAllowed(req.ip || 'unknown')) return res.status(429).json({ error: 'too_many_requests', code: 'too_many_requests' });
  const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const phone = extractPhone(String(b.phone || ''));
  if (!name) return res.status(422).json({ error: 'name_required', code: 'name_required' });
  if (!phone) return res.status(422).json({ error: 'phone_invalid', code: 'phone_invalid' });
  await ensureSchema();
  await ingestLead({
    name, phone,
    // An ad's id or an influencer's ref decides the source on its own;
    // without either, she simply found the page.
    source: String(b.ad_id || '').replace(/[^0-9]/g, '') ? '' : 'אתר',
    ad_id: b.ad_id, ref: b.ref,
    notes: String(b.notes || 'דף נחיתה').slice(0, 480),
    consent: b.consent,
  });
  // Whether the number was already known is nobody's business but ours.
  res.json({ ok: true });
}));
// ---- Meta lead forms ------------------------------------------------------
// A lead form lives inside Meta, so nothing here can read it directly:
// Meta tells us a form was filled (an id and nothing else), and the details
// are fetched with a page token. Three secrets, all environment variables:
//   META_VERIFY_TOKEN – any string; Meta sends it back once to prove whose
//                       endpoint this is
//   META_APP_SECRET   – the app's secret; every delivery is signed with it
//   META_PAGE_TOKEN   – a page access token with leads_retrieval
// (cleanEnv, above: a pasted secret with a stray space or quote makes every
// signature "mismatch" while looking exactly right to the eye.)
const META_VERIFY_TOKEN = cleanEnv(process.env.META_VERIFY_TOKEN);
const META_APP_SECRET = cleanEnv(process.env.META_APP_SECRET);
const META_PAGE_TOKEN = cleanEnv(process.env.META_PAGE_TOKEN);
const GRAPH = 'https://graph.facebook.com/v21.0';

const signedByMeta = req => {
  if (!META_APP_SECRET || !req.rawBody) return false;
  const given = String(req.get('x-hub-signature-256') || '');
  const want = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(req.rawBody).digest('hex');
  return given.length === want.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
};

// A form's questions are the advertiser's own, so they arrive under whatever
// they were called — "full_name", "שם_מלא", a custom question. The phone and
// the name are picked out by what the field looks like; everything else is
// kept as a note, because "how many meals a week" is worth reading.
function fromFormFields(fields) {
  const get = re => fields.find(f => re.test(f.name) && (f.values || []).length);
  const val = f => String((f && f.values && f.values[0]) || '').trim();
  const phone = val(get(/phone|טלפון|נייד|mobile|cell/i));
  const first = val(get(/^first_?name|שם_?פרטי/i));
  const last = val(get(/^last_?name|שם_?משפחה/i));
  const full = val(get(/full_?name|שם_?מלא|^name$|^שם$/i));
  const used = new Set([get(/phone|טלפון|נייד|mobile|cell/i), get(/^first_?name|שם_?פרטי/i), get(/^last_?name|שם_?משפחה/i), get(/full_?name|שם_?מלא|^name$|^שם$/i), get(/email|מייל|דוא/i)]);
  const rest = fields
    .filter(f => !used.has(f) && (f.values || []).length)
    .map(f => `${String(f.name).replace(/_/g, ' ')}: ${(f.values || []).join(', ')}`)
    .join(' · ');
  return { phone, name: full || [first, last].filter(Boolean).join(' '), notes: rest.slice(0, 480) };
}

async function pullMetaLead(leadgenId) {
  const r = await fetch(`${GRAPH}/${encodeURIComponent(leadgenId)}?access_token=${encodeURIComponent(META_PAGE_TOKEN)}`);
  if (!r.ok) throw new Error(`graph ${r.status}`);
  return r.json();
}

app.get('/api/meta/webhook', (req, res) => {
  if (!META_VERIFY_TOKEN) return res.status(503).end();
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === META_VERIFY_TOKEN) {
    return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
  }
  res.status(403).end();
});

app.post('/api/meta/webhook', wrap(async (req, res) => {
  if (!META_APP_SECRET || !META_PAGE_TOKEN) return res.status(503).json({ error: 'meta_not_configured' });
  if (!signedByMeta(req)) {
    // Silent rejection is the worst failure here: Meta looks like it is not
    // sending, when in fact its signature does not match the app secret.
    // Enough to tell a wrong value from a right one without printing either:
    // an app secret is 32 characters, an app id is 15 digits.
    const given = String(req.get('x-hub-signature-256') || '');
    console.warn(`meta webhook rejected: signature does not match META_APP_SECRET `
      + `(secret is ${META_APP_SECRET.length} characters, a real one is 32; `
      + `signature header ${given ? 'present' : 'missing'}; body ${req.rawBody ? req.rawBody.length : 0} bytes)`);
    return res.status(401).json({ error: 'bad_signature' });
  }
  // Answer first: Meta retries anything that is slow, and a retry is a duplicate.
  res.status(200).json({ ok: true });
  await ensureSchema();
  for (const entry of (req.body && req.body.entry) || []) {
    console.log(`meta webhook: ${(entry.changes || []).length} change(s) for page ${entry.id}`);
    for (const ch of entry.changes || []) {
      if (ch.field !== 'leadgen' || !ch.value || !ch.value.leadgen_id) continue;
      try {
        const lead = await pullMetaLead(ch.value.leadgen_id);
        // Meta's "create test lead" fills every field with a placeholder. It
        // proves the pipe works, and storing it would only put a fake person
        // with no phone number in the list.
        if (JSON.stringify(lead.field_data || []).includes('dummy data')) {
          console.log(`meta test lead ${ch.value.leadgen_id}: received and read OK (placeholder data, not stored)`);
          continue;
        }
        const f = fromFormFields(lead.field_data || []);
        const out = await ingestLead({
          name: f.name, phone: f.phone, notes: f.notes,
          ad_id: ch.value.ad_id || lead.ad_id, leadgen_id: ch.value.leadgen_id,
          text: f.phone ? '' : JSON.stringify(lead.field_data || []).slice(0, 400),
        });
        console.log(`meta lead ${ch.value.leadgen_id}: ${out.status} ${JSON.stringify(out.body)}`);
      } catch (e) {
        // Not rethrown: the answer has gone out, and one bad lead must not
        // stop the others in the same delivery.
        console.error(`meta lead ${ch.value.leadgen_id} failed:`, e.message);
      }
    }
  }
}));

app.get('/api/inbound/lead', (req, res) => res.status(405).json({ error: 'use_post', code: 'use_post', message: 'POST JSON {name, phone|text, username} with header X-Webhook-Key' }));

// ---- the personal link in a round message ---------------------------------
// A round goes out over ordinary WhatsApp, and nothing can read the replies
// that come back there. So each message carries the customer's own link, and
// the answer is a button press that lands here: yes, not this time, or stop.
// Whoever pressed nothing did not answer — no one has to keep score by hand.
const ROUND_TOKEN = /^[a-z0-9]{8,64}$/;
const htmlEsc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Orders close Wednesday 23:00 for the Sunday after. Worked out on Israel's
// clock, because the server's own clock is not in Israel.
function deliverySundayIL(now = new Date()) {
  const il = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const wed = new Date(il);
  wed.setDate(il.getDate() + ((3 - il.getDay() + 7) % 7));
  wed.setHours(23, 0, 0, 0);
  if (wed <= il) wed.setDate(wed.getDate() + 7);
  const sun = new Date(wed);
  sun.setDate(wed.getDate() + 4);
  const p = n => String(n).padStart(2, '0');
  return `${sun.getFullYear()}-${p(sun.getMonth() + 1)}-${p(sun.getDate())}`;
}
const dayMonth = iso => `${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}`;

async function leadByRoundToken(token) {
  if (!ROUND_TOKEN.test(token)) return null;
  const [rows] = await pool.query('SELECT id, data FROM leads');
  for (const r of rows) {
    try { const l = JSON.parse(r.data); if (l.roundToken === token) return l; } catch { /* skip */ }
  }
  return null;
}

// The page a customer lands on from their message. It is the brand's own
// paper, ink and green, and it is built around one thing: the label on the
// box that will arrive — which Sunday — because that is the whole question.
const ROUND_CSS = `
:root{--paper:#fafaf8;--ink:#111;--green:#5DA551;--green-deep:#478a3c;--muted:#6b7280;--line:#e5e7eb}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font-family:'Heebo','Arial Hebrew',Arial,sans-serif;font-size:17px;line-height:1.55}
main{width:min(100%,460px);margin:0 auto;padding:22px 22px 36px;min-height:100vh;display:flex;flex-direction:column}
.logo{width:112px;height:auto;display:block}
h1{font-weight:900;font-size:clamp(40px,12.5vw,58px);line-height:1.02;letter-spacing:-.02em;margin:34px 0 26px}
.tag{position:relative;background:var(--green);border-radius:6px;padding:20px 22px 18px;transform:rotate(-1.4deg);margin:0 2px 30px;
  -webkit-mask:radial-gradient(circle 9px at 0 50%,transparent 98%,#000) left/51% 100% no-repeat,radial-gradient(circle 9px at 100% 50%,transparent 98%,#000) right/51% 100% no-repeat;
  mask:radial-gradient(circle 9px at 0 50%,transparent 98%,#000) left/51% 100% no-repeat,radial-gradient(circle 9px at 100% 50%,transparent 98%,#000) right/51% 100% no-repeat}
.tag__day{font-weight:700;font-size:19px;margin:0}
.tag__date{font-weight:900;font-size:clamp(76px,25vw,112px);line-height:.9;letter-spacing:-.03em;margin:4px 0 12px;direction:ltr;text-align:right}
.tag__note{margin:0;font-size:14.5px;border-top:1.5px dashed rgba(17,17,17,.45);padding-top:10px}
.stamp{position:absolute;left:18px;bottom:11px;border:3px solid var(--ink);border-radius:5px;padding:1px 13px 2px;
  font-weight:900;font-size:21px;line-height:1.3;transform:rotate(-7deg) scale(0);opacity:0}
[data-state=order] .tag__note{color:transparent}
[data-state=order] .stamp{animation:stamp .28s cubic-bezier(.2,1.4,.4,1) forwards}
@keyframes stamp{from{transform:rotate(-7deg) scale(1.8);opacity:0}to{transform:rotate(-7deg) scale(1);opacity:1}}
[data-state=decline] .tag,[data-state=stop] .tag{background:var(--line)}
.btn{display:block;width:100%;min-height:58px;border-radius:14px;font:inherit;font-weight:800;font-size:18px;cursor:pointer;margin:0 0 12px;padding:14px 16px}
.btn--yes{background:var(--ink);color:var(--paper);border:2px solid var(--ink)}
.btn--no{background:transparent;color:var(--ink);border:2px solid var(--ink)}
.btn--stop{min-height:44px;border:0;background:none;color:var(--muted);font-weight:400;font-size:15px;text-decoration:underline;text-underline-offset:3px;margin-top:4px}
.btn:focus-visible{outline:3px solid var(--green-deep);outline-offset:3px}
.btn:disabled{opacity:.5;cursor:default}
.answer{font-size:19px;font-weight:700;margin:0 0 8px}
.answer+p{margin:0;color:var(--muted)}
.err{color:#b42318;font-weight:700;margin:0 0 14px}
@media (prefers-reduced-motion:reduce){[data-state=order] .stamp{animation:none;transform:rotate(-7deg);opacity:1}}
`;
const roundShell = (body, origin = '') => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="theme-color" content="#fafaf8">
<title>RIBAK</title>
<meta property="og:title" content="RIBAK | המשלוח של השבוע"><meta property="og:description" content="שף פרטי. במקרר שלך."><meta property="og:image" content="${origin}/r/_og.jpg"><meta property="og:type" content="website">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700;800;900&display=swap" rel="stylesheet">
<style>${ROUND_CSS}</style></head><body><main id="page">
<img class="logo" src="/r/_logo.png" alt="RIBAK" width="112" height="56">
${body}
</main></body></html>`;

const roundNotFound = origin => roundShell(`<h1>הקישור הזה כבר לא פעיל.</h1>
<p class="answer">אפשר פשוט לענות לניב בוואטסאפ.</p>`, origin);

// The address the customer actually used — which, behind a forwarding rule
// on another domain, is that domain and not this server's own.
const publicOrigin = req => `https://${String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim()}`;

const roundPage = ({ first, week, demo, origin }) => roundShell(`
<h1>${first ? `היי ${htmlEsc(first)}.<br>` : ''}אוכל מוכן לשבוע הבא?</h1>
<div class="tag">
  <p class="tag__day">המשלוח הבא, יום ראשון</p>
  <p class="tag__date">${dayMonth(week)}</p>
  <p class="tag__note">ההזמנות נסגרות ביום רביעי ב-23:00</p>
  <div class="stamp" aria-hidden="true">שוריין ✓</div>
</div>
<div id="ask" aria-live="polite">
  <button class="btn btn--yes" data-a="order">כן, תשריינו לי משלוח</button>
  <button class="btn btn--no" data-a="decline">לא הפעם</button>
  <button class="btn btn--stop" data-a="stop">אל תשלחו לי יותר הודעות</button>
</div>
<script>
(function () {
  var done = {
    order: ['שוריין לך משלוח ליום ראשון ${dayMonth(week)}.', 'ניב יחזור אליך בוואטסאפ לסגור את הפרטים.'],
    decline: ['אין בעיה.', 'נדבר לקראת המשלוח הבא.'],
    stop: ['הוסרת מהרשימה.', 'לא יישלחו אליך עוד הודעות.']
  };
  var ask = document.getElementById('ask'), page = document.getElementById('page'), buttons = ask.querySelectorAll('[data-a]');
  var set = function (off) { for (var i = 0; i < buttons.length; i++) buttons[i].disabled = off; };
  var send = function (a) {
    if (${demo ? 'true' : 'false'}) return Promise.resolve();
    return fetch(location.pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: a }) })
      .then(function (r) { if (!r.ok) throw new Error('refused'); });
  };
  ask.addEventListener('click', function (e) {
    var b = e.target.closest('[data-a]');
    if (!b || b.disabled) return;
    var a = b.getAttribute('data-a');
    set(true);
    send(a).then(function () {
      page.setAttribute('data-state', a);
      ask.innerHTML = '<p class="answer">' + done[a][0] + '</p><p>' + done[a][1] + '</p>';
    }).catch(function () {
      set(false);
      var old = ask.querySelector('.err'); if (old) old.remove();
      ask.insertAdjacentHTML('afterbegin', '<p class="err">הלחיצה לא נרשמה. אפשר לנסות שוב, או לענות לניב בוואטסאפ.</p>');
    });
  });
})();
</script>`, origin);

// The page's own images sit under /r/ too, so that the whole thing can be
// served from another domain with a single forwarding rule.
app.get('/r/_logo.png', (req, res) => res.sendFile(path.join(__dirname, 'icons', 'ribak-logo.png'), { maxAge: '7d' }));
app.get('/r/_og.jpg', (req, res) => res.sendFile(path.join(__dirname, 'icons', 'ribak-og.jpg'), { maxAge: '7d' }));

app.get('/r/:token', wrap(async (req, res) => {
  if (!pool) return res.status(503).end();
  await ensureSchema();
  // /r/demo shows the page exactly as a customer sees it, with buttons that
  // answer but record nothing — for looking at it without touching anyone.
  const demo = req.params.token === 'demo';
  const lead = demo ? { name: 'ניב' } : await leadByRoundToken(String(req.params.token || ''));
  res.set('Cache-Control', 'no-store');
  if (!lead) return res.status(404).send(roundNotFound(publicOrigin(req)));
  const first = String(lead.name || '').replace(/לקוחה?|שבוע ניסיון|ניסיון|מנוי/g, ' ').trim().split(/\s+/)[0] || '';
  // Opening the page records nothing: WhatsApp fetches every link once to
  // draw its preview, and that must not count as anyone's answer.
  res.send(roundPage({ first, week: deliverySundayIL(), demo, origin: publicOrigin(req) }));
}));

app.post('/r/:token', wrap(async (req, res) => {
  if (!pool) return res.status(503).end();
  await ensureSchema();
  const action = String((req.body && req.body.action) || '');
  if (!['order', 'decline', 'stop'].includes(action)) return res.status(400).json({ error: 'bad_action' });
  const lead = await leadByRoundToken(String(req.params.token || ''));
  if (!lead) return res.status(404).json({ error: 'not_found' });
  const now = new Date().toISOString();
  const ev = action === 'order' ? { t: now, type: 'ordered', week: deliverySundayIL(), via: 'link' }
    : action === 'decline' ? { t: now, type: 'declined', via: 'link' }
      : { t: now, type: 'optout', via: 'link' };
  // Pressing the same button twice is one answer.
  const last = (lead.events || []).filter(e => e.via === 'link').pop();
  if (!(last && last.type === ev.type && (ev.type !== 'ordered' || last.week === ev.week))) {
    lead.events = [...(lead.events || []), ev];
  }
  if (action === 'stop') lead.noMarketing = true;
  lead.updatedAt = now;
  await pool.query('UPDATE leads SET data = ?, updated_at = ? WHERE id = ?', [JSON.stringify(lead), toSqlDate(now), lead.id]);
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
