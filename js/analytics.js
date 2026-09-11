// Everything the dashboard shows is computed here from the raw leads.
// Analysis is cohort-based: a lead belongs to the period it was created in,
// so "conversion in the last 30 days" means "of leads that came in during
// the last 30 days, how many closed".

import { STAGES, stageIndex, LOST_REASONS, reasonLabel, SOURCES } from './model.js';
import { dayStart, addDays, daysBetween, pct1 } from './util.js';

export const RANGES = [
  { id: '7',   label: '7 ימים',  days: 7 },
  { id: '30',  label: '30 ימים', days: 30 },
  { id: '90',  label: '90 ימים', days: 90 },
  { id: 'all', label: 'הכל',     days: null },
];

export function filterLeads(leads, { range = 'all', source = '' } = {}) {
  const r = RANGES.find(x => x.id === range) || RANGES[3];
  const from = r.days ? dayStart(addDays(new Date(), -(r.days - 1))) : null;
  return leads.filter(l => {
    if (from && new Date(l.createdAt) < from) return false;
    if (source && l.source !== source) return false;
    return true;
  });
}

export function computeAnalytics(allLeads, filters = {}) {
  const leads = filterLeads(allLeads, filters);
  const n = leads.length;
  const won = leads.filter(l => l.status === 'won').length;
  const lost = leads.filter(l => l.status === 'lost').length;
  const active = n - won - lost;

  // ---- funnel ----------------------------------------------------------
  const funnel = STAGES.map((s, i) => {
    const reached = leads.filter(l => stageIndex(l.stage) >= i);
    const advanced = reached.filter(l => stageIndex(l.stage) > i).length;
    const lostHere = reached.filter(l => l.status === 'lost' && l.stage === s.id);
    const activeHere = reached.filter(l => l.status === 'active' && l.stage === s.id).length;
    const wonHere = reached.filter(l => l.status === 'won' && l.stage === s.id).length;
    const reasons = countBy(lostHere, l => l.lostReason)
      .map(([id, count]) => ({ id, label: reasonLabel(id), count }))
      .sort((a, b) => b.count - a.count);
    return {
      stage: s, index: i,
      reached: reached.length, advanced, active: activeHere, lost: lostHere.length, won: wonHere,
      conv: pct1(advanced, reached.length),          // step conversion to the next stage
      convFromStart: pct1(reached.length, n),        // share of all leads that got here
      reasons,
    };
  });

  // ---- lost reasons (overall) ----------------------------------------
  const lostLeads = leads.filter(l => l.status === 'lost');
  const reasons = countBy(lostLeads, l => l.lostReason)
    .map(([id, count]) => {
      const def = LOST_REASONS.find(r => r.id === id);
      const lostAt = countBy(lostLeads.filter(l => l.lostReason === id), l => l.stage)
        .sort((a, b) => b[1] - a[1])[0];
      return { id, label: reasonLabel(id), count, share: pct1(count, lostLeads.length), from: def?.from || [], topStage: lostAt ? lostAt[0] : null };
    })
    .sort((a, b) => b.count - a.count);

  // ---- weekly cohorts ---------------------------------------------------
  const weekly = weeklyCohorts(leads, filters.range);

  // ---- sources ----------------------------------------------------------
  const sources = SOURCES.map(src => {
    const ls = leads.filter(l => l.source === src);
    const w = ls.filter(l => l.status === 'won').length;
    const lo = ls.filter(l => l.status === 'lost').length;
    const trial = ls.filter(l => stageIndex(l.stage) >= stageIndex('trial')).length;
    return { source: src, total: ls.length, won: w, lost: lo, active: ls.length - w - lo, trial, conv: pct1(w, ls.length) };
  }).filter(s => s.total > 0).sort((a, b) => b.total - a.total);

  // ---- time between stages ---------------------------------------------
  const stageDays = STAGES.slice(0, -1).map((s, i) => {
    const next = STAGES[i + 1];
    const samples = [];
    for (const l of leads) {
      const a = l.events.find(e => (e.type === 'advanced' && e.stage === s.id) || (s.id === 'new' && e.type === 'created'));
      const b = l.events.find(e => e.type === 'advanced' && e.stage === next.id);
      if (a && b) samples.push(Math.max(0, (new Date(b.t) - new Date(a.t)) / 86400000));
    }
    const avg = samples.length ? samples.reduce((x, y) => x + y, 0) / samples.length : null;
    const med = samples.length ? median(samples) : null;
    return { from: s, to: next, n: samples.length, avgDays: avg, medianDays: med };
  });
  const wonSamples = leads.filter(l => l.status === 'won').map(l => {
    const e = l.events.find(x => x.type === 'advanced' && x.stage === 'subscribed');
    return e ? (new Date(e.t) - new Date(l.createdAt)) / 86400000 : null;
  }).filter(x => x != null);
  const avgDaysToWin = wonSamples.length ? wonSamples.reduce((a, b) => a + b, 0) / wonSamples.length : null;

  // ---- unanswered attempts ---------------------------------------------
  const attemptEvents = leads.flatMap(l => l.events.filter(e => e.type === 'attempt').map(e => ({ ...e, lead: l })));
  const attemptsByStage = STAGES.map(s => ({ stage: s, count: attemptEvents.filter(e => e.stage === s.id).length }));
  const leadsWithAttempts = new Set(attemptEvents.map(e => e.lead.id)).size;

  // ---- follow-ups due (always across all active leads) -----------------
  const today = dayStart(new Date());
  const activeAll = allLeads.filter(l => l.status === 'active' && l.nextAt);
  const due = {
    overdue: activeAll.filter(l => daysBetween(today, l.nextAt) < 0).length,
    today: activeAll.filter(l => daysBetween(today, l.nextAt) === 0).length,
    upcoming: activeAll.filter(l => daysBetween(today, l.nextAt) > 0).length,
  };

  const trialReached = funnel[stageIndex('trial')].reached;
  return {
    leads, total: n, won, lost, active,
    convTotal: pct1(won, n),
    convTrial: pct1(won, trialReached),
    trialReached,
    funnel, reasons, weekly, sources, stageDays, avgDaysToWin,
    attempts: { total: attemptEvents.length, byStage: attemptsByStage, leads: leadsWithAttempts },
    due,
  };
}

function weeklyCohorts(leads, range) {
  const r = RANGES.find(x => x.id === range);
  const weeks = r?.days ? Math.max(4, Math.ceil(r.days / 7)) : 16;
  const today = dayStart(new Date());
  // Israeli week starts Sunday; JS getDay() is 0 on Sunday already.
  const thisWeekStart = addDays(today, -today.getDay());
  const buckets = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = addDays(thisWeekStart, -7 * i);
    const end = addDays(start, 7);
    const ls = leads.filter(l => { const d = new Date(l.createdAt); return d >= start && d < end; });
    const w = ls.filter(l => l.status === 'won').length;
    const lo = ls.filter(l => l.status === 'lost').length;
    buckets.push({ start, end, total: ls.length, won: w, lost: lo, active: ls.length - w - lo });
  }
  return buckets;
}

function countBy(arr, fn) {
  const m = new Map();
  for (const x of arr) { const k = fn(x) ?? 'other'; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()];
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
