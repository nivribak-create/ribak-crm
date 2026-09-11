// Single source of truth. Leads live in localStorage; every mutation goes
// through a function here so the event timeline stays consistent.

import { STAGES, stageIndex, nextStage, FINAL_STAGE } from './model.js';
import { uid, nowIso, isoDay, addDays } from './util.js';

const KEY = 'ribak-crm:v1';

let state = load();
const listeners = new Set();

export const getState = () => state;
export const getLead = id => state.leads.find(l => l.id === id) || null;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.leads)) return { leads: parsed.leads, settings: parsed.settings || {} };
    }
  } catch (e) { console.warn('load failed', e); }
  return { leads: [], settings: {} };
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { console.warn('save failed', e); }
}

function commit(leads, settings = state.settings) {
  state = { leads, settings };
  persist();
  listeners.forEach(fn => fn(state));
}

function patchLead(id, fn) {
  const leads = state.leads.map(l => {
    if (l.id !== id) return l;
    const copy = { ...l, events: [...l.events] };
    fn(copy);
    copy.updatedAt = nowIso();
    return copy;
  });
  commit(leads);
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
  commit([lead, ...state.leads]);
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
  commit(state.leads.filter(l => l.id !== id));
}

export function replaceAll(leads) {
  commit(leads.map(normalizeLead));
}

export function clearAll() {
  commit([]);
}

export function setSetting(key, value) {
  commit(state.leads, { ...state.settings, [key]: value });
}

// Defensive normalisation for imported data.
function normalizeLead(raw) {
  const t = raw.createdAt || nowIso();
  return {
    id: raw.id || uid(),
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
