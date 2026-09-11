// Single source of truth. Two persistence modes, picked at boot:
//   remote – a server with a database (see server.js); leads are shared
//            between every device and person who logs in.
//   local  – no server; leads live in this browser's localStorage.
// Every mutation goes through a function here so the event timeline stays
// consistent in both modes.

import { STAGES, stageIndex, nextStage, FINAL_STAGE } from './model.js';
import { uid, nowIso, isoDay, addDays } from './util.js';
import * as api from './api.js';

const KEY = 'ribak-crm:v1';

let state = {
  leads: [], settings: {},
  mode: 'local',        // 'local' | 'remote'
  ready: false,         // boot finished
  auth: true,           // remote: logged in?
  configured: true,     // remote: server has DB + password set?
  missing: [],          // remote: env vars still missing
  dbOk: true, dbError: null,
  syncing: 0, lastError: null,
};
const listeners = new Set();

export const getState = () => state;
export const getLead = id => state.leads.find(l => l.id === id) || null;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach(fn => fn(state));
const setState = patch => { state = { ...state, ...patch }; notify(); };

// ---- boot ---------------------------------------------------------------
export async function init() {
  const probe = await api.probe();
  if (probe) {
    state = {
      ...state, mode: 'remote',
      auth: Boolean(probe.authenticated), configured: Boolean(probe.configured),
      missing: probe.missing || [], dbOk: Boolean(probe.dbOk), dbError: probe.dbError || null,
    };
    if (state.auth && state.dbOk) {
      try { await loadRemote(); } catch (e) { state = { ...state, lastError: describe(e) }; }
    }
  } else {
    const local = loadLocal();
    state = { ...state, mode: 'local', auth: true, leads: local.leads, settings: local.settings };
  }
  state = { ...state, ready: true };
  notify();
}

export async function login(password) {
  await api.login(password);
  state = { ...state, auth: true };
  await loadRemote();
  notify();
}

export async function logout() {
  try { await api.logout(); } catch { /* ignore */ }
  setState({ auth: false, leads: [], settings: {} });
}

async function loadRemote() {
  const d = await api.fetchAll();
  const leads = (d.leads || []).map(normalizeLead).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  state = { ...state, leads, settings: d.settings || {}, dbOk: true, dbError: null };
}

// Pull fresh data from the server (other devices' changes). Quiet unless
// something actually changed.
export async function refresh() {
  if (state.mode !== 'remote' || !state.auth || state.syncing) return;
  try {
    const before = JSON.stringify([state.leads, state.settings]);
    await loadRemote();
    if (JSON.stringify([state.leads, state.settings]) !== before) notify();
  } catch (e) { if (e.status === 401) setState({ auth: false }); }
}

// Leads saved in this browser before the database existed — offered for
// upload on first login. Sample data is never migrated.
export function localLeadsForMigration() {
  const local = loadLocal();
  return local.settings.sample ? [] : local.leads;
}

export function clearError() { if (state.lastError) setState({ lastError: null }); }

// ---- persistence --------------------------------------------------------
function loadLocal() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.leads)) return { leads: parsed.leads.map(normalizeLead), settings: parsed.settings || {} };
    }
  } catch (e) { console.warn('load failed', e); }
  return { leads: [], settings: {} };
}

function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify({ leads: state.leads, settings: state.settings })); }
  catch (e) { console.warn('save failed', e); }
}

// changes: { upsert?: lead[], remove?: id[], replace?: boolean, settings?: boolean }
function commit(leads, settings, changes) {
  state = { ...state, leads, settings };
  if (state.mode === 'local') saveLocal();
  else pushChanges(changes);
  notify();
}

async function pushChanges(ch) {
  state = { ...state, syncing: state.syncing + 1 };
  try {
    if (ch.replace) await api.replaceLeads(state.leads);
    for (const l of ch.upsert || []) await api.saveLead(l);
    for (const id of ch.remove || []) await api.removeLead(id);
    if (ch.settings) await api.saveSettings(state.settings);
  } catch (e) {
    state = { ...state, lastError: describe(e) };
    if (e.status === 401) state = { ...state, auth: false };
    notify();
  } finally {
    state = { ...state, syncing: state.syncing - 1 };
    notify();
  }
}

function describe(e) {
  const map = {
    unauthorized: 'ההתחברות פגה – צריך להיכנס שוב',
    db_not_configured: 'השרת לא מחובר לדאטהבייס',
    too_many_attempts: 'יותר מדי ניסיונות – נסה שוב בעוד רבע שעה',
    wrong_password: 'סיסמה שגויה',
  };
  return map[e.code] || `השמירה נכשלה: ${e.message}`;
}

function patchLead(id, fn) {
  let changed = null;
  const leads = state.leads.map(l => {
    if (l.id !== id) return l;
    const copy = { ...l, events: [...l.events] };
    fn(copy);
    copy.updatedAt = nowIso();
    changed = copy;
    return copy;
  });
  if (changed) commit(leads, state.settings, { upsert: [changed] });
}

// ---- mutations --------------------------------------------------------

export function addLead({ name, phone, source, notes = '', nextAt = null, createdAt = null }) {
  const t = createdAt || nowIso();
  const lead = {
    id: uid(),
    name: name.trim(),
    phone: phone.trim(),
    source: source || 'אחר',
    notes: notes.trim(),
    createdAt: t,
    updatedAt: t,
    stage: 'new',
    status: 'active',
    lostReason: null,
    lostAt: null,
    nextAt: nextAt || null,
    attempts: 0,
    events: [{ t, type: 'created', stage: 'new' }],
  };
  commit([lead, ...state.leads], state.settings, { upsert: [lead] });
  return lead;
}

export function updateLead(id, patch) {
  patchLead(id, l => {
    Object.assign(l, patch);
    l.events.push({ t: nowIso(), type: 'edited' });
  });
}

export function setNextAt(id, nextAt) {
  patchLead(id, l => { l.nextAt = nextAt || null; });
}

export function setNotes(id, notes) {
  patchLead(id, l => { l.notes = notes; });
}

export function addNote(id, text) {
  if (!text.trim()) return;
  patchLead(id, l => { l.events.push({ t: nowIso(), type: 'note', text: text.trim() }); });
}

// Move a lead forward one step (or straight to a given stage).
export function advanceLead(id, toStage = null) {
  patchLead(id, l => {
    const target = toStage ? STAGES.find(s => s.id === toStage) : nextStage(l.stage);
    if (!target || stageIndex(target.id) <= stageIndex(l.stage)) return;
    l.stage = target.id;
    l.attempts = 0;
    l.nextAt = null;
    l.status = target.id === FINAL_STAGE ? 'won' : 'active';
    l.lostReason = null; l.lostAt = null;
    l.events.push({ t: nowIso(), type: 'advanced', stage: target.id });
  });
}

export function markLost(id, reasonId, note = '') {
  patchLead(id, l => {
    const t = nowIso();
    l.status = 'lost';
    l.lostReason = reasonId;
    l.lostAt = t;
    l.nextAt = null;
    l.events.push({ t, type: 'lost', stage: l.stage, reason: reasonId, text: note.trim() || undefined });
  });
}

export function restoreLead(id) {
  patchLead(id, l => {
    l.status = l.stage === FINAL_STAGE ? 'won' : 'active';
    l.lostReason = null; l.lostAt = null;
    l.events.push({ t: nowIso(), type: 'restored', stage: l.stage });
  });
}

// "Tried, no answer" — keeps the lead in place, counts the attempt, and
// schedules the next try for tomorrow.
export function logAttempt(id, channel = 'call') {
  patchLead(id, l => {
    l.attempts = (l.attempts || 0) + 1;
    l.nextAt = isoDay(addDays(new Date(), 1));
    l.events.push({ t: nowIso(), type: 'attempt', stage: l.stage, channel });
  });
}

export function deleteLead(id) {
  commit(state.leads.filter(l => l.id !== id), state.settings, { remove: [id] });
}

export function replaceAll(leads, settingsPatch = {}) {
  const settings = { ...state.settings, ...settingsPatch };
  commit(leads.map(normalizeLead), settings, { replace: true, settings: true });
}

export function clearAll() {
  commit([], { ...state.settings, sample: false }, { replace: true, settings: true });
}

export function setSetting(key, value) {
  commit(state.leads, { ...state.settings, [key]: value }, { settings: true });
}

// Defensive normalisation for imported / stored data.
function normalizeLead(raw) {
  const t = raw.createdAt || nowIso();
  return {
    id: String(raw.id || uid()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || uid(),
    name: String(raw.name || '').trim() || 'ללא שם',
    phone: String(raw.phone || '').trim(),
    source: raw.source || 'אחר',
    notes: String(raw.notes || ''),
    createdAt: t,
    updatedAt: raw.updatedAt || t,
    stage: STAGES.some(s => s.id === raw.stage) ? raw.stage : 'new',
    status: ['active', 'won', 'lost'].includes(raw.status) ? raw.status : 'active',
    lostReason: raw.lostReason || null,
    lostAt: raw.lostAt || null,
    nextAt: raw.nextAt || null,
    attempts: Number(raw.attempts) || 0,
    events: Array.isArray(raw.events) && raw.events.length ? raw.events : [{ t, type: 'created', stage: 'new' }],
  };
}
