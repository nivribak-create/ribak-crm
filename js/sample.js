// Example data so the app opens in a working state. Plainly marked as
// examples in the UI; replace it with real leads whenever you like.

import { STAGES, LOST_REASONS, SOURCES } from './model.js';
import { uid, addDays, isoDay } from './util.js';

const FIRST = ['נועה', 'יובל', 'איתי', 'מאיה', 'עומר', 'שירה', 'דניאל', 'תמר', 'עידו', 'רוני', 'ליאור', 'הילה', 'אורי', 'מיכל', 'נדב', 'ענבר', 'אלון', 'טל', 'גיא', 'שני', 'רועי', 'אביב', 'ניב', 'יעל', 'עמית', 'קרן', 'אסף', 'דנה', 'ברק', 'ליאת'];
const LAST = ['כהן', 'לוי', 'מזרחי', 'פרץ', 'ביטון', 'אברהם', 'פרידמן', 'דהן', 'אזולאי', 'חדד', 'גבאי', 'שפירא', 'ברק', 'אוחיון', 'מלכה', 'נחום', 'סגל', 'רוזן', 'עמר', 'קליין'];
const SOURCE_W = [['אינסטגרם', 34], ['פייסבוק', 22], ['גוגל', 14], ['המלצה', 16], ['אתר אינטרנט', 8], ['הגיע למקום', 4], ['אחר', 2]];

// Chance of making it through each step (new→wa, wa→call, call→fu, fu→trial, trial→sub)
const PASS = [0.95, 0.70, 0.78, 0.66, 0.62];
// Reasons a lead is lost when stuck on each stage
const LOST_AT = {
  new:      [['invalid', 5], ['irrelevant', 4], ['call_no_answer', 1]],
  whatsapp: [['wa_no_reply', 6], ['call_no_answer', 8], ['irrelevant', 1]],
  call:     [['call_not_int', 6], ['fu_no_answer', 4], ['fit', 5]],
  followup: [['fu_not_int', 5], ['trial_no_close', 5], ['fit', 3]],
  trial:    [['trial_no_show', 4], ['trial_cancel', 2], ['sub_no_close', 5], ['fit', 2]],
};
const NOTES = ['מעוניין באימוני בוקר', 'שאל על מחיר לזוג', 'חבר של מתאמן קיים', 'מחפש אימון כוח', 'רוצה להתחיל אחרי החגים', 'ביקש שנחזור אחה"צ', '', '', ''];

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const pickW = (r, items) => {
  const total = items.reduce((a, [, w]) => a + w, 0);
  let x = r() * total;
  for (const [v, w] of items) { x -= w; if (x <= 0) return v; }
  return items[items.length - 1][0];
};
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

export function generateSample(count = 140, days = 90, seed = 20260911) {
  const r = rng(seed);
  const leads = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    // more recent weeks slightly busier
    const ago = Math.floor(Math.pow(r(), 1.25) * days);
    const created = addDays(now, -ago);
    created.setHours(9 + Math.floor(r() * 11), Math.floor(r() * 60), 0, 0);
    if (created > now) created.setTime(now.getTime() - Math.floor(r() * 3 * 3600000));
    const name = `${pick(r, FIRST)} ${pick(r, LAST)}`;
    const phone = `05${pick(r, ['0', '2', '3', '4', '8'])}${String(Math.floor(r() * 1e7)).padStart(7, '0')}`;
    const source = pickW(r, SOURCE_W);

    const events = [{ t: created.toISOString(), type: 'created', stage: 'new' }];
    let stage = 'new', status = 'active', lostReason = null, lostAt = null, attempts = 0, nextAt = null;
    let t = new Date(created);
    const gaps = [0.3, 1.4, 2.2, 5, 8]; // typical days between steps

    for (let step = 0; step < PASS.length; step++) {
      const gap = gaps[step] * (0.4 + r() * 1.4);
      const tNext = new Date(t.getTime() + gap * 86400000);
      if (tNext > now) { // still in progress on this stage
        if (r() < 0.5) nextAt = isoDay(addDays(now, Math.floor(r() * 4) - 1));
        if (r() < 0.35) { attempts = 1 + Math.floor(r() * 2); for (let a = 0; a < attempts; a++) events.push({ t: new Date(t.getTime() + (a + 1) * 0.6 * 86400000).toISOString(), type: 'attempt', stage, channel: 'call' }); }
        break;
      }
      // occasional unanswered attempt before a successful call/follow-up
      if ((step === 1 || step === 2) && r() < 0.3) {
        events.push({ t: new Date(t.getTime() + gap * 0.5 * 86400000).toISOString(), type: 'attempt', stage, channel: 'call' });
      }
      if (r() < PASS[step]) {
        stage = STAGES[step + 1].id;
        t = tNext;
        events.push({ t: t.toISOString(), type: 'advanced', stage });
        if (stage === 'subscribed') { status = 'won'; break; }
      } else {
        const lostT = new Date(t.getTime() + gap * 1.6 * 86400000);
        if (lostT > now) { if (r() < 0.6) nextAt = isoDay(addDays(now, Math.floor(r() * 3) - 1)); break; }
        status = 'lost'; lostReason = pickW(r, LOST_AT[stage]); lostAt = lostT.toISOString();
        events.push({ t: lostAt, type: 'lost', stage, reason: lostReason });
        break;
      }
    }
    const notes = pick(r, NOTES);
    leads.push({
      id: uid() + i.toString(36), name, phone, source, notes,
      createdAt: created.toISOString(), updatedAt: events[events.length - 1].t,
      stage, status, lostReason, lostAt, nextAt, attempts, events,
    });
  }
  return leads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
