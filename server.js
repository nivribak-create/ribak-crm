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
// Body: { name?, phone?, text?, source?, notes?, username? }
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
    existing.events = [
      ...(existing.events || []),
      { t: now, type: 'note', text: `פנייה חוזרת (${source})${influencer ? ' · ' + influencer : ''}${noteText ? ' · ' + noteText : ''}` },
      ...(stolen ? [{ t: now, type: 'note', text: `הגיע גם מהלינק של ${influencer} – הקרדיט נשאר אצל ${credited}` }] : []),
      ...(consentNote ? [{ t: now, type: 'note', text: consentNote }] : []),
    ];
    existing.updatedAt = now;
    if (existing.status === 'active' && !existing.nextAt) existing.nextAt = now.slice(0, 10);
    await pool.query('UPDATE leads SET data = ?, updated_at = ? WHERE id = ?', [JSON.stringify(existing), toSqlDate(now), existing.id]);
    return { status: 200, body: { ok: true, created: false, id: existing.id } };
  }
  const lead = {
    id: newId(), name, phone, source, influencer, adId,
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
  return { status: 201, body: { ok: true, created: true, id: lead.id } };
}

app.post('/api/inbound/lead', wrap(async (req, res) => {
  if (!WEBHOOK_KEYS.length) return res.status(503).json({ error: 'webhook_not_configured', code: 'webhook_not_configured' });
  if (!webhookAuthed(req)) return res.status(401).json({ error: 'unauthorized', code: 'unauthorized' });
  await ensureSchema();
  const out = await ingestLead(req.body && typeof req.body === 'object' ? req.body : {});
  res.status(out.status).json(out.body);
}));
// ---- Meta lead forms ------------------------------------------------------
// A lead form lives inside Meta, so nothing here can read it directly:
// Meta tells us a form was filled (an id and nothing else), and the details
// are fetched with a page token. Three secrets, all environment variables:
//   META_VERIFY_TOKEN – any string; Meta sends it back once to prove whose
//                       endpoint this is
//   META_APP_SECRET   – the app's secret; every delivery is signed with it
//   META_PAGE_TOKEN   – a page access token with leads_retrieval
// A secret pasted into a hosting panel picks up a trailing space or a pair of
// quotes more often than anything else, and then every signature "mismatches"
// while looking exactly right to the eye.
const cleanEnv = v => String(v || '').trim().replace(/^["']+|["']+$/g, '').trim();
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
const ROUND_TOKEN = /^[a-f0-9]{16,64}$/;
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

const roundPage = (title, body) => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>RIBAK</title><meta property="og:title" content="RIBAK – המשלוח של השבוע"><meta property="og:description" content="אוכל מבושל טרי עד הבית">
<style>
body{margin:0;font-family:-apple-system,"Segoe UI",Arial,sans-serif;background:#0f1a1b;color:#eef4f4;display:grid;place-items:center;min-height:100vh}
main{width:min(92vw,420px);padding:28px 22px;background:#162526;border-radius:18px;text-align:center;box-sizing:border-box}
h1{font-size:22px;margin:0 0 6px}p{color:#b7c9ca;line-height:1.6;margin:0 0 20px;font-size:16px}
button{display:block;width:100%;padding:15px;border-radius:12px;border:0;font:inherit;font-size:17px;font-weight:600;cursor:pointer;margin-bottom:10px}
.yes{background:#39b5c0;color:#06272a}.no{background:#22393b;color:#eef4f4}.stop{background:none;color:#8aa0a1;font-size:14px;font-weight:400;text-decoration:underline}
small{color:#8aa0a1}
</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

app.get('/r/:token', wrap(async (req, res) => {
  if (!pool) return res.status(503).end();
  await ensureSchema();
  const lead = await leadByRoundToken(String(req.params.token || ''));
  res.set('Cache-Control', 'no-store');
  if (!lead) return res.status(404).send(roundPage('הקישור לא נמצא', '<p>אפשר פשוט לענות לניב בוואטסאפ 🙏</p>'));
  const first = String(lead.name || '').replace(/לקוחה?|שבוע ניסיון|ניסיון|מנוי/g, ' ').trim().split(/\s+/)[0] || '';
  const week = deliverySundayIL();
  // Opening the page records nothing: WhatsApp fetches every link once to
  // draw its preview, and that must not count as anyone's answer.
  res.send(roundPage(`היי ${htmlEsc(first)} 👋`, `
    <div id="ask">
      <p>רוצה משלוח של ריבק ליום ראשון ${dayMonth(week)}?</p>
      <button class="yes" data-a="order">כן, תשריינו לי משלוח</button>
      <button class="no" data-a="decline">לא הפעם</button>
      <button class="stop" data-a="stop">אל תשלחו לי יותר הודעות</button>
    </div>
    <script>
      const done = { order: 'מעולה! רשמנו אותך למשלוח של יום ראשון ${dayMonth(week)}. ניב יחזור אליך בוואטסאפ לסגור פרטים 🙏', decline: 'אין בעיה, נדבר בפעם הבאה 🙏', stop: 'הוסרת מהרשימה. לא נשלח יותר הודעות.' };
      document.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', async () => {
        document.querySelectorAll('[data-a]').forEach(x => { x.disabled = true; });
        try {
          const r = await fetch(location.pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: b.dataset.a }) });
          if (!r.ok) throw new Error();
          document.getElementById('ask').innerHTML = '<p>' + done[b.dataset.a] + '</p>';
        } catch { document.getElementById('ask').innerHTML = '<p>משהו השתבש. אפשר פשוט לענות לניב בוואטסאפ 🙏</p>'; }
      }));
    </script>`));
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
