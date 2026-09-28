// Running a call script. Full-screen because it is read off the screen
// while the phone is at your ear: the lines to say are large and calm, the
// things to write down sit right under the question that produced them.
// Every keystroke is saved, so a call that gets cut off keeps its notes.

import { SCRIPTS, visibleFields, answeredCount, isVisible, cityOutOfArea } from './scripts.js';
import * as store from './store.js';
import { esc, fmtPhone, telLink, waLink, debounce, fmtNum } from './util.js';
import { toast } from './ui.js';
import { openLostDialog, advance, attempt } from './lead.js';

let host = null;
let state = null;   // { leadId, scriptId, section, answers }

export function openScript(leadId, scriptId = 'sales') {
  const lead = store.getLead(leadId);
  if (!lead) return;
  state = {
    leadId, scriptId,
    section: 0,
    answers: { ...(lead.scripts?.[scriptId] || {}) },
  };
  if (!state.answers.startedAt) {
    state.answers.startedAt = new Date().toISOString();
    store.saveScript(leadId, scriptId, { startedAt: state.answers.startedAt });
  }
  mount();
  render();
}

export function closeScript() {
  if (!host) return;
  host.classList.remove('is-open');
  document.body.classList.remove('has-script');
  setTimeout(() => { host?.remove(); host = null; state = null; }, 160);
  document.removeEventListener('keydown', onKey);
}

function onKey(e) {
  if (!state) return;
  if (e.key === 'Escape' && !document.body.classList.contains('has-modal')) closeScript();
}

function mount() {
  host = document.createElement('div');
  host.className = 'scriptview';
  document.body.appendChild(host);
  document.body.classList.add('has-script');
  requestAnimationFrame(() => host.classList.add('is-open'));
  document.addEventListener('keydown', onKey);
}

const save = debounce(() => {
  if (state) store.saveScript(state.leadId, state.scriptId, state.answers);
}, 400);

function render() {
  const lead = store.getLead(state.leadId);
  const script = SCRIPTS[state.scriptId];
  if (!lead || !script) { closeScript(); return; }

  const section = script.sections[state.section];
  const total = script.sections.length;
  const answered = answeredCount(script, state.answers);
  const asked = visibleFields(script, state.answers).length;

  const fill = text => text
    .replace('[שם]', lead.name.split(' ')[0] || lead.name)
    .replace('{why}', state.answers.why?.trim() || '…מה שאמר לך שהוא מחפש…');

  host.innerHTML = `
    <div class="scriptview__bar">
      <button class="icon-btn" data-close-script aria-label="סגירה">✕</button>
      <div class="scriptview__who">
        <b>${esc(lead.name)}</b>
        <a class="contact contact--tel" href="${telLink(lead.phone)}">${esc(fmtPhone(lead.phone))}</a>
        <a class="contact contact--wa" href="${waLink(lead.phone)}" target="_blank" rel="noopener">וואטסאפ</a>
      </div>
      <div class="scriptview__meta">
        <span class="muted">${fmtNum(answered)}/${fmtNum(asked)} תועדו</span>
      </div>
    </div>

    <nav class="steps" aria-label="שלבי השיחה">
      ${script.sections.map((s, i) => `
        <button class="step ${i === state.section ? 'is-on' : ''} ${i < state.section ? 'is-done' : ''}" data-section="${i}">
          <span class="step__n">${i + 1}</span><span class="step__t">${esc(s.title)}</span>
        </button>`).join('')}
    </nav>

    <div class="scriptview__body">
      ${section.note ? `<p class="script__note">${esc(section.note)}</p>` : ''}

      <div class="says">
        ${section.say.map(line => `<p class="say">${esc(fill(line))}</p>`).join('')}
      </div>

      ${section.fields.length ? `
        <div class="records">
          ${section.fields.filter(f => isVisible(f, state.answers)).map(fieldHtml).join('')}
        </div>` : ''}

      ${section.closing ? closingHtml(lead) : ''}
    </div>

    <footer class="scriptview__foot">
      <button class="btn" data-prev ${state.section === 0 ? 'disabled' : ''}>← הקודם</button>
      ${state.section < total - 1
        ? '<button class="btn btn--primary" data-next>הבא →</button>'
        : ''}
    </footer>`;

  host.querySelector('[data-close-script]').addEventListener('click', closeScript);
  host.querySelector('[data-prev]').addEventListener('click', () => go(state.section - 1));
  host.querySelector('[data-next]')?.addEventListener('click', () => go(state.section + 1));
  host.querySelectorAll('[data-section]').forEach(b =>
    b.addEventListener('click', () => go(Number(b.dataset.section))));

  host.querySelectorAll('[data-field]').forEach(el => {
    const id = el.dataset.field;
    el.addEventListener('input', () => { state.answers[id] = el.value; save(); maybeFlagArea(id); });
    el.addEventListener('change', () => { state.answers[id] = el.value; save(); renderIfBranching(id); });
  });
  host.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
    const { pick, value } = b.dataset;
    state.answers[pick] = state.answers[pick] === value ? '' : value;
    save();
    render();
  }));

  host.querySelector('[data-outcome-close]')?.addEventListener('click', () => finish('closed'));
  host.querySelector('[data-outcome-think]')?.addEventListener('click', () => finish('open'));
  host.querySelector('[data-outcome-lost]')?.addEventListener('click', () => finish('lost'));
  host.querySelector('[data-outcome-noanswer]')?.addEventListener('click', () => finish('no_answer'));

  host.querySelector('.scriptview__body').scrollTop = 0;
}

// Choice fields change which later questions apply, so they redraw.
function renderIfBranching(id) {
  if (['tried', 'ordered'].includes(id)) render();
}

function maybeFlagArea(id) {
  if (id !== 'city') return;
  const warn = host.querySelector('[data-area-warn]');
  if (warn) warn.hidden = !cityOutOfArea(state.answers.city);
}

function go(i) {
  const script = SCRIPTS[state.scriptId];
  state.section = Math.max(0, Math.min(script.sections.length - 1, i));
  render();
}

function fieldHtml(f) {
  const v = state.answers[f.id] ?? '';
  const label = `
    <span class="record__ask">${esc(f.ask)}${f.key ? '<i class="record__key" title="חשוב – יופיע בשיחת ההמרה">★</i>' : ''}</span>
    ${f.hint ? `<span class="record__hint">${esc(f.hint)}</span>` : ''}`;

  if (f.type === 'choice') {
    return `<div class="record">
      ${label}
      <div class="chips chips--wrap">
        ${f.options.map(o => `<button class="chip ${v === o ? 'is-on' : ''}" data-pick="${f.id}" data-value="${esc(o)}">${esc(o)}</button>`).join('')}
      </div>
    </div>`;
  }
  const extra = f.id === 'city'
    ? `<p class="record__warn" data-area-warn ${cityOutOfArea(v) ? '' : 'hidden'}>נראה שזה מחוץ לאזור החלוקה (אשדוד–נתניה)</p>`
    : '';
  const input = f.type === 'textarea'
    ? `<textarea class="input" data-field="${f.id}" rows="${f.rows || 2}" placeholder="${esc(f.placeholder || 'מה הוא ענה…')}">${esc(v)}</textarea>`
    : `<input class="input" data-field="${f.id}" type="${f.type === 'number' ? 'number' : 'text'}" ${f.type === 'number' ? 'inputmode="numeric" min="0"' : ''} value="${esc(v)}" placeholder="${esc(f.placeholder || '')}">`;
  return `<div class="record">${label}${input}${extra}</div>`;
}

function closingHtml(lead) {
  return `
    <div class="outcome-box">
      <h3>איך נגמרה השיחה?</h3>
      <div class="outcome-box__actions">
        <button class="btn btn--primary" data-outcome-close>✓ סגר שבוע ניסיון</button>
        <button class="btn" data-outcome-think>עוד חושב – פולואפ</button>
        <button class="btn" data-outcome-noanswer>לא ענה</button>
        <button class="btn btn--danger-ghost" data-outcome-lost>לא מעוניין</button>
      </div>
      <p class="field__hint">מה שתיעדת נשמר בכל מקרה, גם אם השיחה לא נגמרה בסגירה.</p>
    </div>`;
}

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
  const lead = store.getLead(state.leadId);
  const { leadId, scriptId } = state;
  state.answers.outcome = outcome;
  store.saveScript(leadId, scriptId, state.answers);
  store.finishScript(leadId, scriptId, summarize());

  // The pitch itself is progress even when nothing was sold.
  if (['new', 'contacted'].includes(lead.stage)) store.advanceLead(leadId, 'pitched');

  const after = store.getLead(leadId);
  closeScript();

  if (outcome === 'closed') { store.advanceLead(leadId, 'trial'); toast(`${after.name} סגר שבוע ניסיון 🎉`, 'good'); }
  else if (outcome === 'no_answer') { attempt(after); }
  else if (outcome === 'lost') { openLostDialog(store.getLead(leadId)); }
  else { toast('השיחה תועדה – קבע פולואפ בכרטיס'); }
}
