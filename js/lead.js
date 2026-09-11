// Lead dialogs and the detail drawer — shared by every view.
import { STAGES, STAGE_BY_ID, stageIndex, nextStage, LOST_REASONS, reasonLabel, SOURCES, STATUS, EVENT_LABELS, FINAL_STAGE } from './model.js';
import * as store from './store.js';
import { openModal, confirmDialog, toast, field, select, formData } from './ui.js';
import { esc, fmtPhone, waLink, telLink, fmtDate, fmtDateLong, fmtDateTime, relDays, dueLabel, daysBetween, todayIso } from './util.js';

// ---- add / edit ---------------------------------------------------------
export function openLeadForm(lead = null) {
  const isEdit = !!lead;
  const body = `
    <form class="form" id="lead-form">
      ${field('שם', `<input class="input" name="name" required value="${esc(lead?.name || '')}" placeholder="שם מלא" autocomplete="off">`)}
      ${field('טלפון', `<input class="input" name="phone" required inputmode="tel" value="${esc(lead?.phone || '')}" placeholder="050-0000000" autocomplete="off">`)}
      ${field('מקור', select('source', SOURCES, lead?.source || 'אינסטגרם'))}
      ${field('פעולה הבאה', `<input class="input" type="date" name="nextAt" value="${esc(lead?.nextAt || '')}">`, 'מתי לחזור אליו')}
      ${field('הערות', `<textarea class="input" name="notes" rows="3" placeholder="מה הוא מחפש, שעות נוחות, כל דבר שיעזור בשיחה">${esc(lead?.notes || '')}</textarea>`)}
    </form>`;
  const m = openModal({
    title: isEdit ? 'עריכת ליד' : 'ליד חדש',
    body,
    footer: `<button class="btn" data-close>ביטול</button><button class="btn btn--primary" type="submit" form="lead-form">${isEdit ? 'שמירה' : 'הוספת ליד'}</button>`,
  });
  m.el.querySelector('#lead-form').addEventListener('submit', e => {
    e.preventDefault();
    const d = formData(e.target);
    if (!d.name || !d.phone) return;
    if (isEdit) {
      store.updateLead(lead.id, { name: d.name, phone: d.phone, source: d.source, notes: d.notes, nextAt: d.nextAt || null });
      toast('הפרטים נשמרו');
    } else {
      store.addLead(d);
      toast(`${d.name} נוסף לפייפליין`, 'good');
    }
    m.close();
  });
}

// ---- lost ---------------------------------------------------------------
export function openLostDialog(lead) {
  const relevant = LOST_REASONS.filter(r => r.from.includes(lead.stage));
  const others = LOST_REASONS.filter(r => !r.from.includes(lead.stage));
  const radio = r => `
    <label class="choice">
      <input type="radio" name="reason" value="${r.id}">
      <span>${esc(r.label)}</span>
    </label>`;
  const body = `
    <form class="form" id="lost-form">
      <p class="modal__text">${esc(lead.name)} נמצא בשלב <b>${esc(STAGE_BY_ID[lead.stage].label)}</b>. מה קרה?</p>
      <div class="choices">${relevant.map(radio).join('')}</div>
      <details class="more">
        <summary>סיבות נוספות</summary>
        <div class="choices">${others.map(radio).join('')}</div>
      </details>
      ${field('הערה (לא חובה)', `<input class="input" name="note" placeholder="למשל: אמר שיחזור אחרי החגים">`)}
    </form>`;
  const m = openModal({
    title: 'סימון ליד כאבוד',
    body,
    footer: `<button class="btn" data-close>ביטול</button><button class="btn btn--danger" type="submit" form="lost-form">סימון כאבוד</button>`,
  });
  m.el.querySelector('#lost-form').addEventListener('submit', e => {
    e.preventDefault();
    const d = formData(e.target);
    if (!d.reason) { toast('בחר סיבה', 'warn'); return; }
    store.markLost(lead.id, d.reason, d.note);
    toast(`${lead.name} סומן כאבוד – ${reasonLabel(d.reason)}`);
    m.close();
  });
}

// ---- shared actions -----------------------------------------------------
export function advance(lead) {
  const next = nextStage(lead.stage);
  if (!next) return;
  store.advanceLead(lead.id);
  toast(next.id === FINAL_STAGE ? `🎉 ${lead.name} סגר מנוי!` : `${lead.name} → ${next.label}`, next.id === FINAL_STAGE ? 'good' : '');
}
export function attempt(lead) {
  store.logAttempt(lead.id, 'call');
  toast(`נרשם ניסיון ללא מענה · ננסה שוב מחר`);
}
export function restore(lead) {
  store.restoreLead(lead.id);
  toast(`${lead.name} חזר לפייפליין`, 'good');
}
export async function remove(lead) {
  const ok = await confirmDialog({ title: 'מחיקת ליד', text: `למחוק את ${lead.name} לצמיתות? הפעולה לא ניתנת לביטול.`, okLabel: 'מחיקה', danger: true });
  if (ok) { store.deleteLead(lead.id); toast('הליד נמחק'); closeDrawer(); }
}

// Buttons that appear on cards and in the drawer.
export function actionButtons(lead, { compact = false } = {}) {
  if (lead.status === 'lost') {
    return `<button class="btn btn--sm" data-act="restore" data-id="${lead.id}">↩ החזר לפייפליין</button>`;
  }
  if (lead.status === 'won') {
    return `<span class="won-tag">✓ מנוי פעיל</span>`;
  }
  const next = nextStage(lead.stage);
  const canAttempt = ['whatsapp', 'call', 'followup', 'new'].includes(lead.stage);
  return `
    <button class="btn btn--sm btn--primary" data-act="advance" data-id="${lead.id}" title="${esc(next.label)}">✓ ${esc(next.action)}</button>
    ${canAttempt ? `<button class="btn btn--sm btn--ghost" data-act="attempt" data-id="${lead.id}" title="נרשם ניסיון, ננסה שוב מחר">לא ענה</button>` : ''}
    <button class="btn btn--sm btn--ghost btn--lost" data-act="lost" data-id="${lead.id}" title="סימון כאבוד">✕${compact ? '' : ' אבד'}</button>`;
}

// One delegated handler for every view.
export function handleAction(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return false;
  const lead = store.getLead(b.dataset.id);
  if (!lead) return false;
  e.stopPropagation();
  switch (b.dataset.act) {
    case 'advance': advance(lead); break;
    case 'attempt': attempt(lead); break;
    case 'lost': openLostDialog(lead); break;
    case 'restore': restore(lead); break;
    case 'edit': openLeadForm(lead); break;
    case 'delete': remove(lead); break;
    case 'open': openDrawer(lead.id); break;
  }
  return true;
}

// ---- drawer -------------------------------------------------------------
let drawerEl = null, drawerId = null, unsub = null;

export function openDrawer(id) {
  drawerId = id;
  if (!drawerEl) {
    drawerEl = document.createElement('aside');
    drawerEl.className = 'drawer';
    drawerEl.innerHTML = `<div class="drawer__backdrop"></div><div class="drawer__panel" role="dialog" aria-label="פרטי ליד"></div>`;
    document.body.appendChild(drawerEl);
    drawerEl.querySelector('.drawer__backdrop').addEventListener('click', closeDrawer);
    drawerEl.addEventListener('click', e => {
      if (e.target.closest('[data-close-drawer]')) { closeDrawer(); return; }
      handleAction(e);
    });
    drawerEl.addEventListener('submit', e => {
      if (e.target.matches('#note-form')) {
        e.preventDefault();
        const input = e.target.querySelector('input');
        store.addNote(drawerId, input.value);
        input.value = '';
      }
    });
    drawerEl.addEventListener('change', e => {
      if (e.target.matches('[name="nextAt"]')) store.setNextAt(drawerId, e.target.value);
      if (e.target.matches('[name="notes"]')) store.setNotes(drawerId, e.target.value);
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && drawerEl?.classList.contains('is-open') && !document.body.classList.contains('has-modal')) closeDrawer(); });
    unsub = store.subscribe(() => { if (drawerId && drawerEl.classList.contains('is-open')) renderDrawer(); });
  }
  renderDrawer();
  requestAnimationFrame(() => drawerEl.classList.add('is-open'));
  document.body.classList.add('has-drawer');
}

export function closeDrawer() {
  if (!drawerEl) return;
  drawerEl.classList.remove('is-open');
  document.body.classList.remove('has-drawer');
  drawerId = null;
  if (location.hash.startsWith('#/lead/')) history.replaceState(null, '', '#/' + (sessionStorage.getItem('ribak:view') || 'pipeline'));
}

function renderDrawer() {
  const lead = store.getLead(drawerId);
  const panel = drawerEl.querySelector('.drawer__panel');
  if (!lead) { panel.innerHTML = `<div class="empty">הליד לא נמצא</div>`; return; }
  const idx = stageIndex(lead.stage);
  const days = daysBetween(lead.createdAt, new Date());
  const lastEvent = lead.events[lead.events.length - 1];
  const stageSince = [...lead.events].reverse().find(e => e.type === 'advanced' || e.type === 'created');
  const inStage = stageSince ? daysBetween(stageSince.t, new Date()) : 0;

  const stepper = STAGES.map((s, i) => {
    const cls = i < idx ? 'is-done' : i === idx ? (lead.status === 'lost' ? 'is-lost' : lead.status === 'won' ? 'is-won' : 'is-current') : '';
    return `<li class="stepper__step ${cls}"><span class="stepper__dot"></span><span class="stepper__label">${esc(s.short)}</span></li>`;
  }).join('');

  const timeline = [...lead.events].reverse().map(ev => {
    let text = EVENT_LABELS[ev.type] || ev.type;
    if (ev.type === 'advanced') text = STAGE_BY_ID[ev.stage]?.done || text;
    if (ev.type === 'lost') text = `סומן כאבוד · ${reasonLabel(ev.reason)}`;
    if (ev.type === 'attempt') text = `ניסיון ${ev.channel === 'whatsapp' ? 'בוואטסאפ' : 'טלפוני'} ללא מענה`;
    if (ev.type === 'note') text = ev.text;
    return `<li class="tl__item tl__item--${ev.type}">
      <span class="tl__dot"></span>
      <div class="tl__body"><div class="tl__text">${esc(text)}${ev.type === 'lost' && ev.text ? `<div class="tl__note">"${esc(ev.text)}"</div>` : ''}</div><time class="tl__time">${fmtDateTime(ev.t)}</time></div>
    </li>`;
  }).join('');

  const statusTag = lead.status === 'won' ? `<span class="tag tag--won">סגר מנוי</span>`
    : lead.status === 'lost' ? `<span class="tag tag--lost">אבד · ${esc(reasonLabel(lead.lostReason))}</span>`
    : `<span class="tag tag--active">${esc(STAGE_BY_ID[lead.stage].label)}</span>`;

  panel.innerHTML = `
    <header class="drawer__head">
      <button class="icon-btn" data-close-drawer aria-label="סגירה">✕</button>
      <div>
        <h2 class="drawer__name">${esc(lead.name)}</h2>
        <div class="drawer__sub">${statusTag}<span class="muted">נכנס ${fmtDateLong(lead.createdAt)} · ${esc(lead.source)}</span></div>
      </div>
    </header>
    <div class="drawer__contact">
      <a class="contact contact--tel" href="${telLink(lead.phone)}">📞 ${esc(fmtPhone(lead.phone))}</a>
      <a class="contact contact--wa" href="${waLink(lead.phone)}" target="_blank" rel="noopener">וואטסאפ</a>
      <button class="btn btn--sm btn--ghost" data-act="edit" data-id="${lead.id}">עריכה</button>
    </div>
    <ol class="stepper">${stepper}</ol>
    <div class="drawer__stats">
      <div><b>${days}</b><span>ימים במערכת</span></div>
      <div><b>${inStage}</b><span>ימים בשלב</span></div>
      <div><b>${lead.attempts || 0}</b><span>ניסיונות ללא מענה</span></div>
    </div>
    <div class="drawer__actions">${actionButtons(lead)}</div>
    <div class="drawer__fields">
      ${field('פעולה הבאה', `<input class="input" type="date" name="nextAt" value="${esc(lead.nextAt || '')}" min="">`, lead.nextAt ? dueLabel(lead.nextAt) : '')}
      ${field('הערות', `<textarea class="input" name="notes" rows="3" placeholder="הערות קבועות על הליד">${esc(lead.notes || '')}</textarea>`)}
    </div>
    <section class="drawer__timeline">
      <h3>היסטוריה</h3>
      <form id="note-form" class="note-form"><input class="input" placeholder="הוסף הערה להיסטוריה…" autocomplete="off"><button class="btn btn--sm" type="submit">הוסף</button></form>
      <ol class="tl">${timeline}</ol>
    </section>
    <footer class="drawer__foot"><button class="btn btn--sm btn--ghost btn--lost" data-act="delete" data-id="${lead.id}">מחיקת הליד</button></footer>`;
}
