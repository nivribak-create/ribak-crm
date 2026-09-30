// Bulk triage — "מיון מהיר". A contact list you already have, sorted into
// the pipeline one card at a time: pick the stage, the card flies off, the
// next one lands. Each choice is written straight to the database, so a
// session that stops halfway keeps everything already sorted.

import { STAGES, LOST_REASONS, SOURCES, INFLUENCER_SOURCE, UNKNOWN_SOURCE, reasonLabel, DISQUALIFYING } from '../model.js';
import * as store from '../store.js';
import { readFile, readText } from '../import.js';
import { esc, fmtNum, fmtPhone, waLink, telLink, plural } from '../util.js';
import { toast, copyBtn } from '../ui.js';

const ui = {
  queue: [],        // rows waiting to be sorted
  index: 0,
  history: [],      // { row, leadId } — for undo
  skipped: [],
  source: UNKNOWN_SOURCE,
  influencer: '',
  duplicates: 0,
  phase: 'drop',    // drop | play | done
  streak: 0,
  best: 0,
};

let keyHandler = null;

export function render(root, state) {
  if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
  if (ui.phase === 'play' && ui.index >= ui.queue.length) ui.phase = 'done';

  if (ui.phase === 'drop') renderDrop(root, state);
  else if (ui.phase === 'play') renderPlay(root, state);
  else renderDone(root, state);
}

const rerender = () => {
  const root = document.getElementById('view');
  render(root, store.getState());
};

// ---- 1. the drop zone ---------------------------------------------------
function renderDrop(root, state) {
  root.innerHTML = `
    <div class="triage">
      <header class="triage__intro">
        <h1>מיון מהיר</h1>
        <p>יש לך רשימת אנשי קשר? גרור אותה לכאן, ותמיין את כולם לפייפליין בלחיצה אחת לכל אחד.</p>
      </header>

      <label class="drop" id="drop">
        <input type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt" hidden id="file">
        <span class="drop__icon" aria-hidden="true">
          <svg viewBox="0 0 48 48" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M24 32V10"/><path d="M15 19l9-9 9 9"/><path d="M8 32v4a4 4 0 004 4h24a4 4 0 004-4v-4"/>
          </svg>
        </span>
        <span class="drop__title">גרור לכאן קובץ אקסל או CSV</span>
        <span class="drop__sub">או לחץ כדי לבחור קובץ מהמחשב</span>
      </label>

      <details class="triage__paste">
        <summary>או הדבק רשימה מהאקסל</summary>
        <textarea class="input" id="paste" rows="5" placeholder="טלפון ושם בכל שורה – אפשר להעתיק עמודות ישר מהאקסל"></textarea>
        <button class="btn btn--primary" id="paste-go">קרא את הרשימה</button>
      </details>

      <p class="triage__privacy">
        הקובץ נקרא כאן בדפדפן שלך ולא נשלח לשום מקום. רק הלידים שתמיין נשמרים בדאטהבייס שלך.
      </p>
    </div>`;

  const drop = root.querySelector('#drop');
  const input = root.querySelector('#file');
  input.addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); });

  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.add('is-over');
  }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); if (ev === 'dragleave' && drop.contains(e.relatedTarget)) return;
    drop.classList.remove('is-over');
  }));
  drop.addEventListener('drop', e => {
    const file = e.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });

  root.querySelector('#paste-go').addEventListener('click', () => {
    const text = root.querySelector('#paste').value;
    if (!text.trim()) { toast('אין מה לקרוא – הדבק רשימה קודם', 'warn'); return; }
    start(readText(text));
  });
}

async function loadFile(file) {
  try {
    start(await readFile(file));
  } catch (e) {
    const msgs = {
      old_xls: 'הקובץ בפורמט ישן (.xls). שמור אותו כ-.xlsx ונסה שוב',
      not_a_zip: 'לא הצלחתי לקרוא את הקובץ – ודא שזה קובץ אקסל או CSV',
      no_sheet: 'לא נמצא גיליון בקובץ',
      unsupported_browser: 'הדפדפן הזה לא יודע לפתוח אקסל. שמור כ-CSV ונסה שוב',
    };
    toast(msgs[e.message] || `לא הצלחתי לקרוא את הקובץ: ${e.message}`, 'warn');
  }
}

function start({ leads, skipped }) {
  const fresh = [];
  let duplicates = 0;
  for (const row of leads) {
    if (store.findByPhone(row.phone)) duplicates++;
    else fresh.push(row);
  }
  if (!fresh.length) {
    toast(duplicates ? `כל ${fmtNum(duplicates)} הלידים כבר במערכת` : 'לא מצאתי מספרי טלפון בקובץ', 'warn');
    return;
  }
  Object.assign(ui, {
    queue: fresh, index: 0, history: [], skipped: [],
    duplicates, phase: 'play', streak: 0, best: 0,
  });
  const parts = [`${fmtNum(fresh.length)} ${plural(fresh.length, 'ליד', 'לידים')} למיון`];
  if (duplicates) parts.push(`${fmtNum(duplicates)} כבר במערכת`);
  if (skipped) parts.push(`${fmtNum(skipped)} שורות בלי מספר תקין`);
  toast(parts.join(' · '), 'good');
  rerender();
}

// ---- 2. the game --------------------------------------------------------
const STREAK_NOTES = ['', '', 'יפה 🔥', 'רצף!', 'מעולה 🔥', 'אש', 'טס על זה 🚀', 'בלתי ניתן לעצירה'];

function renderPlay(root) {
  const row = ui.queue[ui.index];
  const total = ui.queue.length;
  const done = ui.index;
  const pct = Math.round((done / total) * 100);
  const influencers = store.knownInfluencers();

  root.innerHTML = `
    <div class="triage triage--play">
      <div class="progress">
        <div class="progress__bar"><span style="width:${pct}%"></span></div>
        <div class="progress__meta">
          <b>${fmtNum(done)}</b> מתוך ${fmtNum(total)}
          ${ui.streak >= 2 ? `<span class="streak">${esc(STREAK_NOTES[Math.min(ui.streak, STREAK_NOTES.length - 1)])} ×${ui.streak}</span>` : ''}
        </div>
      </div>

      <div class="deck">
        ${total - done > 2 ? '<div class="deck__ghost deck__ghost--2"></div>' : ''}
        ${total - done > 1 ? '<div class="deck__ghost deck__ghost--1"></div>' : ''}
        <article class="tcard" id="card">
          <div class="tcard__id">
            <input class="tcard__name" id="name" value="${esc(row.name)}" placeholder="ללא שם – אפשר להוסיף" autocomplete="off" aria-label="שם">
            <div class="tcard__contact">
              <a class="contact contact--tel" href="${telLink(row.phone)}">${esc(fmtPhone(row.phone))}</a>
              ${copyBtn(row.phone)}
              <a class="contact contact--wa" href="${waLink(row.phone)}" target="_blank" rel="noopener">וואטסאפ</a>
            </div>
          </div>

          <div class="tcard__section">
            <span class="tcard__label">מאיפה הגיע</span>
            <div class="chips chips--wrap" id="sources">
              ${SOURCES.map(s => `<button class="chip ${ui.source === s ? 'is-on' : ''}" data-source="${esc(s)}">${esc(s)}</button>`).join('')}
            </div>
            <div class="tcard__infl ${ui.source === INFLUENCER_SOURCE ? '' : 'is-hidden'}">
              <input class="input input--sm" id="influencer" list="influencers" value="${esc(ui.influencer)}" placeholder="שם המשפיען" autocomplete="off">
              <datalist id="influencers">${influencers.map(i => `<option value="${esc(i)}"></option>`).join('')}</datalist>
            </div>
          </div>

          <div class="tcard__section">
            <span class="tcard__label">איפה הוא עומד היום</span>
            <div class="stages" id="stages">
              ${STAGES.map((s, i) => `
                <button class="stagebtn" data-stage="${s.id}" style="--c:var(--f${i})">
                  <kbd>${i + 1}</kbd><span>${esc(s.label)}</span>
                </button>`).join('')}
              <button class="stagebtn stagebtn--lost" data-lost><kbd>0</kbd><span>אבד</span></button>
              <button class="stagebtn stagebtn--churn" data-churn><kbd>9</kbd><span>היה מנוי והפסיק</span></button>
            </div>
          </div>

          <div class="tcard__reasons is-hidden" id="reasons">
            <span class="tcard__label">עד איפה הוא הגיע?</span>
            <div class="chips chips--wrap" id="lost-stages">
              ${STAGES.slice(0, -1).map((s2, i) => `<button class="chip" data-lost-stage="${s2.id}" style="--c:var(--f${i})">${esc(s2.label)}</button>`).join('')}
            </div>
            <div class="is-hidden" id="lost-why">
              <span class="tcard__label">ולמה אבד?</span>
              <div class="chips chips--wrap" id="lost-reasons"></div>
            </div>
            <button class="btn btn--sm btn--ghost" data-cancel-lost>ביטול</button>
          </div>
        </article>
      </div>

      <div class="triage__foot">
        <button class="btn btn--ghost" id="undo" ${ui.history.length ? '' : 'disabled'}>↩ בטל אחרון</button>
        <button class="btn btn--ghost" id="skip">דלג <kbd>S</kbd></button>
        <button class="btn btn--ghost" id="quit">סיים כאן</button>
      </div>
    </div>`;

  const card = root.querySelector('#card');
  const reasons = root.querySelector('#reasons');
  const stages = root.querySelector('#stages');

  root.querySelector('#sources').addEventListener('click', e => {
    const b = e.target.closest('[data-source]');
    if (!b) return;
    ui.source = b.dataset.source;
    root.querySelectorAll('[data-source]').forEach(x => x.classList.toggle('is-on', x === b));
    root.querySelector('.tcard__infl').classList.toggle('is-hidden', ui.source !== INFLUENCER_SOURCE);
    if (ui.source === INFLUENCER_SOURCE) root.querySelector('#influencer')?.focus();
  });

  root.querySelector('#influencer')?.addEventListener('input', e => { ui.influencer = e.target.value.trim(); });

  stages.addEventListener('click', e => {
    const s = e.target.closest('[data-stage]');
    if (s) { commit(s.dataset.stage, null, card); return; }
    if (e.target.closest('[data-lost]')) { openLost(); return; }
    if (e.target.closest('[data-churn]')) { openChurn(); }
  });

  let lostStage = null;
  let churnMode = false;
  const why = root.querySelector('#lost-why');
  const whyChips = root.querySelector('#lost-reasons');
  const stagePicker = root.querySelector('#lost-stages');
  const lostTitle = reasons.querySelector('.tcard__label');

  const openLost = () => {
    churnMode = false;
    lostTitle.textContent = 'עד איפה הוא הגיע?';
    stagePicker.classList.remove('is-hidden');
    why.classList.add('is-hidden');
    reasons.classList.remove('is-hidden');
    stages.classList.add('is-dim');
  };
  // An ex-subscriber reached the end of the pipeline — only the reason is
  // still open, so the stage picker is skipped entirely.
  const openChurn = () => {
    churnMode = true;
    lostStage = 'subscribed';
    lostTitle.textContent = 'למה הוא הפסיק את המנוי?';
    stagePicker.classList.add('is-hidden');
    whyChips.innerHTML = LOST_REASONS.filter(r => r.from.includes('subscribed') || !r.from.length)
      .map(r => `<button class="chip chip--lost" data-reason="${r.id}">${esc(r.label)}</button>`).join('');
    why.classList.remove('is-hidden');
    reasons.classList.remove('is-hidden');
    stages.classList.add('is-dim');
  };
  const closeLost = () => {
    reasons.classList.add('is-hidden'); stages.classList.remove('is-dim');
    why.classList.add('is-hidden'); stagePicker.classList.remove('is-hidden');
    lostStage = null; churnMode = false;
    root.querySelectorAll('[data-lost-stage]').forEach(x => x.classList.remove('is-on'));
  };
  reasons.addEventListener('click', e => {
    if (e.target.closest('[data-cancel-lost]')) { closeLost(); return; }

    const st = e.target.closest('[data-lost-stage]');
    if (st) {
      lostStage = st.dataset.lostStage;
      root.querySelectorAll('[data-lost-stage]').forEach(x => x.classList.toggle('is-on', x === st));
      const list = LOST_REASONS.filter(r => r.from.includes(lostStage) || !r.from.length);
      whyChips.innerHTML = list.map(r => `<button class="chip chip--lost ${DISQUALIFYING.has(r.id) ? 'chip--disq' : ''}" data-reason="${r.id}" ${DISQUALIFYING.has(r.id) ? 'title="לא נספר ככישלון מכירה"' : ''}>${esc(r.label)}${DISQUALIFYING.has(r.id) ? ' ∅' : ''}</button>`).join('');
      why.classList.remove('is-hidden');
      return;
    }

    const r = e.target.closest('[data-reason]');
    if (r && lostStage) commit(lostStage, r.dataset.reason, card, churnMode);
  });

  root.querySelector('#undo').addEventListener('click', undo);
  root.querySelector('#skip').addEventListener('click', () => skip(card));
  root.querySelector('#quit').addEventListener('click', () => { ui.phase = 'done'; rerender(); });

  keyHandler = e => {
    if (!card.isConnected) { document.removeEventListener('keydown', keyHandler); return; }
    if (e.target instanceof Element && e.target.matches('input, textarea')) { if (e.key === 'Enter') e.target.blur(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const n = Number(e.key);
    if (n >= 1 && n <= STAGES.length) { e.preventDefault(); commit(STAGES[n - 1].id, null, card); return; }
    if (e.key === '0') { e.preventDefault(); openLost(); return; }
    if (e.key === '9') { e.preventDefault(); openChurn(); return; }
    if (e.key === 'Escape' && !reasons.classList.contains('is-hidden')) { e.preventDefault(); closeLost(); return; }
    if (e.key.toLowerCase() === 's') { e.preventDefault(); skip(card); return; }
    if (e.key.toLowerCase() === 'u' || e.key === 'Backspace') { e.preventDefault(); undo(); }
  };
  document.addEventListener('keydown', keyHandler);
}

function currentName() {
  const el = document.getElementById('name');
  return (el ? el.value : '').trim();
}

function fly(card, direction, after) {
  if (!card || matchMedia('(prefers-reduced-motion: reduce)').matches) { after(); return; }
  card.classList.add(direction === 'lost' ? 'is-out-lost' : direction === 'skip' ? 'is-out-skip' : 'is-out-won');
  setTimeout(after, 170);
}

function commit(stage, lostReason, card, churned = false) {
  const row = ui.queue[ui.index];
  if (!row) return;
  const name = currentName();
  const lead = store.importLead({
    name: name || row.name,
    phone: row.phone,
    source: ui.source,
    influencer: ui.source === INFLUENCER_SOURCE ? ui.influencer : '',
    stage,
    lostReason,
    churned,
  });
  ui.history.push({ row, leadId: lead.id });
  ui.streak = lostReason ? 0 : ui.streak + 1;
  ui.best = Math.max(ui.best, ui.streak);
  ui.index++;
  fly(card, lostReason ? 'lost' : 'won', rerender);
}

function skip(card) {
  const row = ui.queue[ui.index];
  if (!row) return;
  ui.skipped.push(row);
  ui.history.push({ row, leadId: null });
  ui.streak = 0;
  ui.index++;
  fly(card, 'skip', rerender);
}

function undo() {
  const last = ui.history.pop();
  if (!last) return;
  if (last.leadId) store.deleteLead(last.leadId);
  else ui.skipped.pop();
  ui.index = Math.max(0, ui.index - 1);
  ui.streak = 0;
  if (ui.phase === 'done') ui.phase = 'play';
  rerender();
}

// ---- 3. the finish ------------------------------------------------------
function renderDone(root) {
  const sorted = ui.history.filter(h => h.leadId).length;
  const left = ui.queue.length - ui.index;
  root.innerHTML = `
    <div class="triage triage--done">
      <canvas class="confetti" id="confetti" aria-hidden="true"></canvas>
      <div class="done">
        <div class="done__mark">✓</div>
        <h1>${sorted ? 'מיינת ' + fmtNum(sorted) + ' ' + plural(sorted, 'ליד', 'לידים') : 'לא מוין כלום'}</h1>
        <div class="done__stats">
          <div><b>${fmtNum(sorted)}</b><span>נכנסו לפייפליין</span></div>
          <div><b>${fmtNum(ui.skipped.length)}</b><span>דילגת</span></div>
          <div><b>${fmtNum(ui.duplicates)}</b><span>כבר היו במערכת</span></div>
          ${ui.best >= 3 ? `<div><b>${fmtNum(ui.best)}</b><span>הרצף הכי ארוך</span></div>` : ''}
        </div>
        <div class="done__actions">
          ${left ? `<button class="btn btn--primary" id="resume">המשך – נשארו ${fmtNum(left)}</button>` : ''}
          <a class="btn ${left ? '' : 'btn--primary'}" href="#/pipeline">לפייפליין</a>
          <button class="btn" id="again">רשימה נוספת</button>
          ${ui.history.length ? '<button class="btn btn--ghost" id="undo">↩ בטל אחרון</button>' : ''}
        </div>
      </div>
    </div>`;

  root.querySelector('#resume')?.addEventListener('click', () => { ui.phase = 'play'; rerender(); });
  root.querySelector('#undo')?.addEventListener('click', undo);
  root.querySelector('#again').addEventListener('click', () => {
    Object.assign(ui, { queue: [], index: 0, history: [], skipped: [], duplicates: 0, phase: 'drop', streak: 0, best: 0 });
    rerender();
  });
  if (sorted) confetti(root.querySelector('#confetti'));
}

function confetti(canvas) {
  if (!canvas || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, devicePixelRatio || 1);
  const resize = () => {
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
  };
  resize();
  const styles = getComputedStyle(document.documentElement);
  const colors = ['--f1', '--f3', '--f5', '--accent', '--warn'].map(v => styles.getPropertyValue(v).trim() || '#0F7A84');
  const bits = Array.from({ length: 90 }, () => ({
    x: Math.random() * canvas.width,
    y: -Math.random() * canvas.height * 0.4,
    vx: (Math.random() - 0.5) * 2 * dpr,
    vy: (1.5 + Math.random() * 2.5) * dpr,
    w: (4 + Math.random() * 5) * dpr,
    h: (7 + Math.random() * 7) * dpr,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.2,
    c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  (function frame(now) {
    const life = now - start;
    if (life > 2600 || !canvas.isConnected) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = life > 1900 ? Math.max(0, 1 - (life - 1900) / 700) : 1;
    for (const b of bits) {
      b.x += b.vx; b.y += b.vy; b.rot += b.vr; b.vy += 0.03 * dpr;
      ctx.save();
      ctx.translate(b.x, b.y); ctx.rotate(b.rot);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    requestAnimationFrame(frame);
  })(start);
}
