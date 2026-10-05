// Single source of truth. Two persistence modes, picked at boot:
//   remote – a server with a database (see server.js); leads are shared
//            between every device and person who logs in.
//   local  – no server; leads live in this browser's localStorage.
// Every mutation goes through a function here so the event timeline stays
// consistent in both modes.

import { STAGES, stageIndex, nextStage, FINAL_STAGE, LEGACY_STAGES, LEGACY_REASONS, LEGACY_SOURCES, SOURCES, UNKNOWN_SOURCE, STATUSES } from './model.js';
import { uid, nowIso, isoDay, addDays, normPhone, cleanPhone } from './util.js';
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

// A PUT sends the lead's whole record, so the last request to reach the
// server wins. One click can fire several mutations — finishing a call
// script saves the answers, closes the script and then moves the lead —
// and firing those requests at once let the earlier, staler record land
// last: a lead that closed a trial week was stored back at "שיחת מכירה".
// So requests go out one at a time, and while a lead waits its turn only
// its newest version is kept.
const pending = { leads: new Map(), remove: new Set(), settings: false, replace: false };
let draining = null;
const hasPending = () => pending.replace || pending.leads.size > 0 || pending.remove.size > 0 || pending.settings;

function pushChanges(ch) {
  // Replacing everything supersedes anything queued for single leads.
  if (ch.replace) { pending.leads.clear(); pending.remove.clear(); pending.replace = true; }
  for (const l of ch.upsert || []) { pending.remove.delete(l.id); pending.leads.set(l.id, l); }
  for (const id of ch.remove || []) { pending.leads.delete(id); pending.remove.add(id); }
  if (ch.settings) pending.settings = true;
  if (!draining) draining = drain();
}

async function drain() {
  state = { ...state, syncing: state.syncing + 1 };
  try {
    while (hasPending()) {
      try {
        if (pending.replace) { pending.replace = false; await api.replaceLeads(state.leads); }
        else if (pending.leads.size) {
          const [id, lead] = pending.leads.entries().next().value;
          pending.leads.delete(id);
          await api.saveLead(lead);
        } else if (pending.remove.size) {
          const id = pending.remove.values().next().value;
          pending.remove.delete(id);
          await api.removeLead(id);
        } else if (pending.settings) { pending.settings = false; await api.saveSettings(state.settings); }
      } catch (e) {
        // Stop after a failure instead of hammering the server; whatever is
        // still queued goes out with the next change.
        state = { ...state, lastError: describe(e) };
        if (e.status === 401) state = { ...state, auth: false };
        notify();
        break;
      }
    }
  } finally {
    draining = null;
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
    phone: cleanPhone(phone),
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

// Script answers are saved continuously while a call is happening, so they
// must not each push an event onto the timeline — only finishing does.
export function saveScript(id, scriptId, patch) {
  patchLead(id, l => {
    const all = { ...(l.scripts || {}) };
    all[scriptId] = { ...(all[scriptId] || {}), ...patch };
    l.scripts = all;
  });
}

export function finishScript(id, scriptId, summary) {
  patchLead(id, l => {
    const all = { ...(l.scripts || {}) };
    all[scriptId] = { ...(all[scriptId] || {}), completedAt: nowIso() };
    l.scripts = all;
    l.events.push({ t: nowIso(), type: 'script', script: scriptId, text: summary });
  });
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

// Dragging a card puts it wherever it was dropped — forwards, backwards,
// or out of the lost pile — which plain advancing deliberately refuses.
export function moveToStage(id, stageId) {
  if (!STAGES.some(s => s.id === stageId)) return;
  patchLead(id, l => {
    const forward = stageIndex(stageId) > stageIndex(l.stage);
    if (l.stage === stageId && l.status === 'active') return;
    l.stage = stageId;
    l.status = stageId === FINAL_STAGE ? 'won' : 'active';
    l.lostReason = null;
    l.lostAt = null;
    if (forward) { l.attempts = 0; l.nextAt = null; }
    l.events.push({ t: nowIso(), type: forward ? 'advanced' : 'moved', stage: stageId });
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

export function markChurned(id, reasonId, note = '') {
  patchLead(id, l => {
    const t = nowIso();
    l.status = 'churned';
    l.lostReason = reasonId;
    l.lostAt = t;
    l.nextAt = null;
    l.events.push({ t, type: 'churned', stage: l.stage, reason: reasonId, text: note.trim() || undefined });
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
    // A lead nobody has tried to reach and one that isn't picking up are
    // different problems, so the first failed attempt moves it along.
    if (l.stage === 'new') {
      l.stage = 'followup';
      l.events.push({ t: nowIso(), type: 'advanced', stage: 'followup' });
    }
  });
}

// A call that happened, recorded without moving the lead anywhere.
export function logTalk(id, at = null) {
  patchLead(id, l => {
    if ((l.events || []).some(e => e.type === 'talked')) return;
    l.events.push({ t: at || nowIso(), type: 'talked', stage: l.stage });
    l.events.sort((a, b) => (a.t < b.t ? -1 : 1));
  });
}

// Several at once, in one write: going through them one by one would push
// a separate save per lead.
export function logTalkMany(ids) {
  const want = new Set(ids);
  const t = nowIso();
  const changed = [];
  const leads = state.leads.map(l => {
    if (!want.has(l.id) || (l.events || []).some(e => e.type === 'talked')) return l;
    const lost = (l.events || []).find(e => e.type === 'lost' || e.type === 'churned');
    const at = lost ? new Date(new Date(lost.t).getTime() - 60000).toISOString() : t;
    const copy = {
      ...l,
      updatedAt: t,
      events: [...l.events, { t: at, type: 'talked', stage: lost?.stage || l.stage }]
        .sort((a, b) => (a.t < b.t ? -1 : 1)),
    };
    changed.push(copy);
    return copy;
  });
  if (changed.length) commit(leads, state.settings, { upsert: changed });
  return changed.length;
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

// ---- influencer partnerships -------------------------------------------
export const getInfluencers = () => (Array.isArray(state.settings.influencers) ? state.settings.influencers : []);

export function saveInfluencer(inf) {
  const list = getInfluencers();
  const t = nowIso();
  const clean = {
    id: inf.id || uid(),
    handle: String(inf.handle || '').trim().replace(/^@/, ''),
    // The id a gateway link puts on a lead, which is usually shorter than
    // the handle — "shir" for @shirtaran. Without it her leads land on a
    // card of their own and the collaboration looks like two people.
    ref: String(inf.ref || '').trim().replace(/^@/, ''),
    name: String(inf.name || '').trim(),
    phone: String(inf.phone || '').trim(),
    status: inf.status || 'wishlist',
    followers: String(inf.followers || '').trim(),
    notes: String(inf.notes || '').trim(),
    createdAt: inf.createdAt || t,
    updatedAt: t,
  };
  if (!clean.handle) return null;
  const i = list.findIndex(x => x.id === clean.id);
  const next = i >= 0 ? list.map(x => (x.id === clean.id ? clean : x)) : [clean, ...list];
  commit(state.leads, { ...state.settings, influencers: next }, { settings: true });
  return clean;
}

// Adding several at once (the "pull them out of the leads" flow) writes a
// single settings update instead of one per person.
export function saveInfluencers(list) {
  const existing = getInfluencers();
  const taken = new Set(existing.map(x => x.handle.toLowerCase()));
  const t = nowIso();
  const added = [];
  for (const inf of list) {
    const handle = String(inf.handle || '').trim().replace(/^@/, '');
    if (!handle || taken.has(handle.toLowerCase())) continue;
    taken.add(handle.toLowerCase());
    added.push({
      id: uid(), handle,
      name: String(inf.name || '').trim(),
      phone: String(inf.phone || '').trim(),
      status: inf.status || 'wishlist',
      followers: '', notes: String(inf.notes || '').trim(),
      createdAt: t, updatedAt: t,
    });
  }
  if (added.length) commit(state.leads, { ...state.settings, influencers: [...added, ...existing] }, { settings: true });
  return added;
}

export function setInfluencerStatus(id, status) {
  const next = getInfluencers().map(x => (x.id === id ? { ...x, status, updatedAt: nowIso() } : x));
  commit(state.leads, { ...state.settings, influencers: next }, { settings: true });
}

export function deleteInfluencer(id) {
  commit(state.leads, { ...state.settings, influencers: getInfluencers().filter(x => x.id !== id) }, { settings: true });
}

export function setSetting(key, value) {
  commit(state.leads, { ...state.settings, [key]: value }, { settings: true });
}

// Defensive normalisation for stored data, and the migration path from the
// first pipeline (which had a "follow-up" stage and generic sources) to the
// one built around the real Ribak flow.
function normalizeLead(raw) {
  const t = raw.createdAt || nowIso();
  const stage = STAGES.some(s => s.id === raw.stage) ? raw.stage : (LEGACY_STAGES[raw.stage] || 'new');
  const lostReason = raw.lostReason ? (LEGACY_REASONS[raw.lostReason] || raw.lostReason) : null;
  const source = SOURCES.includes(raw.source) ? raw.source : (LEGACY_SOURCES[raw.source] || raw.source || UNKNOWN_SOURCE);
  return {
    id: String(raw.id || uid()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || uid(),
    name: String(raw.name || '').trim() || 'ללא שם',
    phone: cleanPhone(raw.phone),
    source,
    influencer: String(raw.influencer || '').trim(),
    via: raw.via === 'magnet' ? 'magnet' : '',
    owner: String(raw.owner || '').trim(),
    notes: String(raw.notes || ''),
    createdAt: t,
    updatedAt: raw.updatedAt || t,
    stage,
    status: STATUSES.includes(raw.status) ? raw.status : 'active',
    lostReason,
    lostAt: raw.lostAt || null,
    nextAt: raw.nextAt || null,
    attempts: Number(raw.attempts) || 0,
    scripts: raw.scripts && typeof raw.scripts === 'object' ? raw.scripts : {},
    events: (Array.isArray(raw.events) && raw.events.length ? raw.events : [{ t, type: 'created', stage: 'new' }])
      .map(e => (e.stage && LEGACY_STAGES[e.stage] ? { ...e, stage: LEGACY_STAGES[e.stage] } : e)),
  };
}

// ---- import ------------------------------------------------------------
export const findByPhone = phone => {
  const d = normPhone(phone);
  return d ? state.leads.find(l => normPhone(l.phone) === d) || null : null;
};

export const knownInfluencers = () =>
  [...new Set(state.leads.map(l => l.influencer).filter(Boolean))].sort();

// Build a lead that is already partway down the pipeline, with a timeline
// that says so. Used by the bulk triage screen; one call per lead so a
// stopped session keeps everything already sorted.
export function importLead({ name, phone, source, influencer = '', stage = 'new', lostReason = null, churned = false, notes = '', createdAt = null }) {
  const t = createdAt || nowIso();
  const idx = Math.max(0, stageIndex(stage));
  const events = [{ t, type: 'imported', stage: 'new' }];
  for (let i = 1; i <= idx; i++) events.push({ t, type: 'advanced', stage: STAGES[i].id, imported: true });
  const ended = Boolean(lostReason) || churned;
  const status = churned ? 'churned'
    : lostReason ? 'lost'
    : (STAGES[idx].id === FINAL_STAGE ? 'won' : 'active');
  if (ended) events.push({ t, type: churned ? 'churned' : 'lost', stage: STAGES[idx].id, reason: lostReason || undefined, imported: true });
  const lead = normalizeLead({
    id: uid(), name, phone, source, influencer, notes,
    createdAt: t, updatedAt: t,
    stage: STAGES[idx].id,
    status,
    lostReason: lostReason || null,
    lostAt: ended ? t : null,
    nextAt: null, attempts: 0, events,
  });
  commit([lead, ...state.leads], state.settings, { upsert: [lead] });
  return lead;
}
