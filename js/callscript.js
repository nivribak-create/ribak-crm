// Running a call script, built for the one situation it is used in: a
// phone against your ear while you read and type. Two rules follow from
// that — nothing on screen may jump while you work (so the view is built
// once and then patched, never re-rendered), and the next step is always
// reachable without hunting (so the controls are pinned to the bottom).

import { SCRIPTS, visibleFields, isVisible, cityOutOfArea } from './scripts.js';
import * as store from './store.js';
import { esc, fmtPhone, telLink, waLink, debounce, fmtNum } from './util.js';
import { toast, copyBtn } from './ui.js';
import { openLostDialog, attempt } from './lead.js';

let host = null;
let state = null;   // { leadId, scriptId, section, answers, said:Set }

// ---- lifecycle ----------------------------------------------------------
export function openScript(leadId, scriptId = 'sales') {
  const lead = store.getLead(leadId);
  if (!lead) return;
  state = {
    leadId, scriptId, section: 0,
    answers: { ...(lead.scripts?.[scriptId] || {}) },
    said: new Set(),
  };
  if (!state.answers.startedAt) {
    state.answers.startedAt = new Date().toISOString();
    store.saveScript(leadId, scriptId, { startedAt: state.answers.startedAt });
  }
  // Resume where the answers stop, so a call picked back up opens in the
  // right place instead of at the greeting.
  state.section = firstUnfinished();
  build();
  document.addEventListener('keydown', onKey);
}

export function closeScript() {
  if (!host) return;
  host.classList.remove('is-open');
  document.body.classList.remove('has-script');
  const dying = host;
  setTimeout(() => dying.remove(), 160);
  host = null; state = null;
  document.removeEventListener('keydown', onKey);
}

function firstUnfinished() {
  const script = SCRIPTS[state.scriptId];
  for (let i = 0; i < script.sections.length; i++) {
    const fields = script.sections[i].fields.filter(f => isVisible(f, state.answers));
    if (fields.some(f => !String(state.answers[f.id] ?? '').trim())) return i;
  }
  return 0;
}

function onKey(e) {
  if (!state) return;
  if (e.key === 'Escape' && !document.body.classList.contains('has-modal')) { closeScript(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); go(state.section + 1); }
}

const save = debounce(() => {
  if (state) store.saveScript(state.leadId, state.scriptId, state.answers);
}, 400);

// ---- the shell, built once ---------------------------------------------
function build() {
  const lead = store.getLead(state.leadId);
  const script = SCRIPTS[state.scriptId];

  host = document.createElement('div');
  host.className = 'callview';
  host.innerHTML = `
    <header class="callview__top">
      <button class="icon-btn" data-close aria-label="סגירת התסריט">✕</button>
      <div class="callview__who">
        <b>${esc(lead.name)}</b>
        <span class="callview__tags">
          <a class="contact contact--tel" href="${telLink(lead.phone)}">${esc(fmtPhone(lead.phone))}</a>
          ${copyBtn(lead.phone)}
          <a class="contact contact--wa" href="${waLink(lead.phone)}" target="_blank" rel="noopener">וואטסאפ</a>
        </span>
      </div>
      <div class="callview__done"><b data-answered>0</b><span data-total>0</span></div>
      <div class="callview__line"><span data-line></span></div>
    </header>

    <nav class="rail" aria-label="שלבי השיחה">
      ${script.sections.map((s, i) => `
        <button class="rail__step" data-section="${i}">
          <span class="rail__dot"></span><span class="rail__label">${esc(s.title)}</span>
        </button>`).join('')}
    </nav>

    <div class="callview__scroll" data-scroll></div>

    <footer class="callview__bottom">
      <button class="btn btn--lg" data-prev>← הקודם</button>
      <button class="btn btn--lg btn--primary" data-next></button>
    </footer>`;

  document.body.appendChild(host);
  document.body.classList.add('has-script');
  requestAnimationFrame(() => host.classList.add('is-open'));

  host.querySelector('[data-close]').addEventListener('click', closeScript);
  host.querySelector('[data-prev]').addEventListener('click', () => go(state.section - 1));
  host.querySelector('[data-next]').addEventListener('click', () => go(state.section + 1));
  host.querySelectorAll('[data-section]').forEach((b, i) => b.addEventListener('click', () => go(i)));

  // One delegated listener for the whole scroll area — nothing is rebound
  // when a field appears or disappears.
  const scroll = host.querySelector('[data-scroll]');
  scroll.addEventListener('input', e => {
    const f = e.target.closest('[data-field]');
    if (!f) return;
    state.answers[f.dataset.field] = f.value;
    autoGrow(f);
    if (f.dataset.field === 'city') flagArea();
    syncConditionals();
    updateProgress();
    save();
  });
  scroll.addEventListener('click', e => {
    const chip = e.target.closest('[data-pick]');
    if (chip) {
      const { pick, value } = chip.dataset;
      state.answers[pick] = state.answers[pick] === value ? '' : value;
      chip.parentElement.querySelectorAll('[data-pick]').forEach(c =>
        c.classList.toggle('is-on', c.dataset.value === state.answers[pick]));
      syncConditionals();
      updateProgress();
      save();
      return;
    }
    const say = e.target.closest('.say');
    if (say) {
      const i = say.dataset.say;
      if (state.said.has(i)) state.said.delete(i); else state.said.add(i);
      say.classList.toggle('is-said', state.said.has(i));
      return;
    }
    const act = e.target.closest('[data-outcome]');
    if (act) finish(act.dataset.outcome);
  });
  // Enter moves on to the next field instead of doing nothing.
  scroll.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const f = e.target.closest('[data-field]');
    if (!f || f.tagName === 'TEXTAREA') return;
    e.preventDefault();
    const all = [...scroll.querySelectorAll('[data-field]')].filter(x => x.offsetParent);
    all[all.indexOf(f) + 1]?.focus();
  });

  paintSection();
}

// ---- one section at a time ---------------------------------------------
function paintSection() {
  const lead = store.getLead(state.leadId);
  const script = SCRIPTS[state.scriptId];
  const section = script.sections[state.section];
  const last = state.section === script.sections.length - 1;

  const fill = t => t
    .replace('[שם]', lead.name.split(' ')[0] || lead.name)
    .replace('{why}', state.answers.why?.trim() || '…מה שאמר לך שהוא מחפש…');

  const scroll = host.querySelector('[data-scroll]');
  scroll.innerHTML = `
    <div class="sheet">
      <h1 class="sheet__title">${esc(section.title)}</h1>
      ${section.note ? `<p class="sheet__note">${esc(section.note)}</p>` : ''}
      <div class="says">
        ${section.say.map((line, i) => `
          <p class="say" data-say="${state.section}-${i}" title="לחיצה מסמנת שאמרת">${esc(fill(line))}</p>`).join('')}
      </div>
      ${section.fields.length ? `<div class="records">${section.fields.map(askHtml).join('')}</div>` : ''}
      ${last ? endHtml() : ''}
    </div>`;

  host.querySelectorAll('.rail__step').forEach((b, i) => {
    b.classList.toggle('is-on', i === state.section);
    b.classList.toggle('is-done', i < state.section);
  });
  host.querySelector('[data-prev]').disabled = state.section === 0;
  const next = host.querySelector('[data-next]');
  next.hidden = last;
  if (!last) next.textContent = `${script.sections[state.section + 1].title} →`;

  scroll.querySelectorAll('textarea[data-field]').forEach(autoGrow);
  syncConditionals();
  updateProgress();
  flagArea();
  scroll.scrollTop = 0;
}

function go(i) {
  const script = SCRIPTS[state.scriptId];
  const n = Math.max(0, Math.min(script.sections.length - 1, i));
  if (n === state.section) return;
  state.section = n;
  paintSection();
}

// ---- patches, never rebuilds -------------------------------------------
function syncConditionals() {
  host.querySelectorAll('[data-record]').forEach(el => {
    const field = fieldById(el.dataset.record);
    if (field) el.hidden = !isVisible(field, state.answers);
  });
}

function updateProgress() {
  const script = SCRIPTS[state.scriptId];
  const fields = visibleFields(script, state.answers);
  const done = fields.filter(f => String(state.answers[f.id] ?? '').trim()).length;
  host.querySelector('[data-answered]').textContent = fmtNum(done);
  host.querySelector('[data-total]').textContent = `מתוך ${fmtNum(fields.length)} תועדו`;
  host.querySelector('[data-line]').style.width = `${fields.length ? (done / fields.length) * 100 : 0}%`;
}

function flagArea() {
  const warn = host.querySelector('[data-area-warn]');
  if (warn) warn.hidden = !cityOutOfArea(state.answers.city);
}

function autoGrow(el) {
  if (el.tagName !== 'TEXTAREA') return;
  el.style.height = 'auto';
  el.style.height = `${Math.max(48, el.scrollHeight)}px`;
}

const fieldById = id => SCRIPTS[state.scriptId].sections.flatMap(s => s.fields).find(f => f.id === id);

// ---- pieces -------------------------------------------------------------
function askHtml(f) {
  const v = state.answers[f.id] ?? '';
  const head = `
    <span class="ask__q">${esc(f.ask)}${f.key ? '<i class="ask__key" title="חשוב – יופיע בשיחת ההמרה">★</i>' : ''}</span>
    ${f.hint ? `<span class="ask__hint">${esc(f.hint)}</span>` : ''}`;

  let control;
  if (f.type === 'choice') {
    control = `<div class="picks">${f.options.map(o =>
      `<button class="pick ${v === o ? 'is-on' : ''}" data-pick="${f.id}" data-value="${esc(o)}">${esc(o)}</button>`).join('')}</div>`;
  } else if (f.type === 'textarea') {
    control = `<textarea class="write" data-field="${f.id}" rows="1" placeholder="${esc(f.placeholder || 'מה הוא ענה…')}">${esc(v)}</textarea>`;
  } else {
    control = `<input class="write" data-field="${f.id}" type="${f.type === 'number' ? 'number' : 'text'}"
      ${f.type === 'number' ? 'inputmode="numeric" min="0"' : ''} value="${esc(v)}" placeholder="${esc(f.placeholder || '')}">`;
  }
  const extra = f.id === 'city'
    ? '<p class="ask__warn" data-area-warn hidden>נראה שזה מחוץ לאזור החלוקה (אשדוד–נתניה)</p>'
    : '';
  return `<div class="ask" data-record="${f.id}">${head}${control}${extra}</div>`;
}

function endHtml() {
  return `
    <div class="end">
      <h2>איך נגמרה השיחה?</h2>
      <div class="end__actions">
        <button class="btn btn--lg btn--primary" data-outcome="closed">✓ סגר שבוע ניסיון</button>
        <button class="btn btn--lg" data-outcome="open">עוד חושב</button>
        <button class="btn btn--lg" data-outcome="no_answer">לא ענה</button>
        <button class="btn btn--lg btn--danger-ghost" data-outcome="lost">לא מעוניין</button>
      </div>
      <p class="end__hint">מה שתיעדת כבר נשמר – גם אם השיחה לא נגמרה בסגירה.</p>
    </div>`;
}

// ---- finishing ----------------------------------------------------------
function summarize() {
  const a = state.answers;
  const bits = [];
  if (a.why) bits.push(`מטרה: ${a.why.trim()}`);
  if (a.current) bits.push(`אוכל היום: ${a.current}`);
  if (a.meals) bits.push(`${a.meals} ארוחות בשבוע`);
  if (a.city) bits.push(a.city);
  if (a.dislikes) bits.push(`לא אוכל: ${a.dislikes}`);
  return bits.join(' · ') || 'בוצעה שיחת מכירה';
}

function finish(outcome) {
  const { leadId, scriptId } = state;
  const lead = store.getLead(leadId);
  state.answers.outcome = outcome;
  store.saveScript(leadId, scriptId, state.answers);
  store.finishScript(leadId, scriptId, summarize());

  // Having pitched is progress even when nothing was sold.
  if (lead.stage === 'new') store.advanceLead(leadId, 'pitched');
  closeScript();

  const after = store.getLead(leadId);
  if (outcome === 'closed') { store.advanceLead(leadId, 'trial'); toast(`${after.name} סגר שבוע ניסיון 🎉`, 'good'); }
  else if (outcome === 'no_answer') attempt(after);
  else if (outcome === 'lost') openLostDialog(after);
  else toast('השיחה תועדה – קבע פולואפ בכרטיס');
}
