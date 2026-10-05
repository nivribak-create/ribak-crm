// Lead dialogs and the detail drawer — shared by every view.
import { STAGES, STAGE_BY_ID, stageIndex, nextStage, LOST_REASONS, reasonLabel, SOURCES, INFLUENCER_SOURCE, STATUS, EVENT_LABELS, FINAL_STAGE, INFLUENCER_STATUSES, COLLAB_RE, handleFrom, DISQUALIFYING } from './model.js';
import * as store from './store.js';
import { openModal, confirmDialog, toast, field, select, formData, copyBtn } from './ui.js';
import { openScript } from './callscript.js';
import { SALES_SCRIPT, visibleFields } from './scripts.js';
import { preserve } from './render.js';
import { esc, fmtPhone, waLink, telLink, fmtDate, fmtDateLong, fmtDateTime, relDays, dueLabel, daysBetween, todayIso, phoneProblem } from './util.js';

// ---- add / edit ---------------------------------------------------------
export function openLeadForm(lead = null) {
  const isEdit = !!lead;
  const body = `
    <form class="form" id="lead-form">
      ${field('שם', `<input class="input" name="name" required value="${esc(lead?.name || '')}" placeholder="שם מלא" autocomplete="off">`)}
      <label class="field">
        <span class="field__label">טלפון</span>
        <input class="input" name="phone" required inputmode="tel" value="${esc(lead?.phone || '')}" placeholder="050-0000000" autocomplete="off">
        <span class="field__warn" data-phone-warn hidden></span>
      </label>
      ${field('מקור', select('source', SOURCES, lead?.source || SOURCES[0]))}
      <label class="field" data-infl ${lead?.source === INFLUENCER_SOURCE ? '' : 'hidden'}>
        <span class="field__label">שם המשפיען</span>
        <input class="input" name="influencer" list="infl-list" value="${esc(lead?.influencer || '')}" placeholder="למשל: @noa_fit" autocomplete="off">
        <datalist id="infl-list">${store.knownInfluencers().map(i => `<option value="${esc(i)}"></option>`).join('')}</datalist>
      </label>
      ${field('פעולה הבאה', `<input class="input" type="date" name="nextAt" value="${esc(lead?.nextAt || '')}">`, 'מתי לחזור אליו')}
      ${field('הערות', `<textarea class="input" name="notes" rows="3" placeholder="מה הוא מחפש, שעות נוחות, כל דבר שיעזור בשיחה">${esc(lead?.notes || '')}</textarea>`)}
    </form>`;
  const m = openModal({
    title: isEdit ? 'עריכת ליד' : 'ליד חדש',
    body,
    footer: `<button class="btn" data-close>ביטול</button><button class="btn btn--primary" type="submit" form="lead-form">${isEdit ? 'שמירה' : 'הוספת ליד'}</button>`,
  });
  const form0 = m.el.querySelector('#lead-form');
  form0.addEventListener('change', e => {
    if (e.target.name === 'source') form0.querySelector('[data-infl]').hidden = e.target.value !== INFLUENCER_SOURCE;
  });
  // A number that cannot be dialled is worth saying out loud before it is
  // saved, but not worth refusing — there is always an exception.
  const phoneWarn = form0.querySelector('[data-phone-warn]');
  const checkPhone = () => {
    const problem = form0.phone.value.trim() ? phoneProblem(form0.phone.value) : null;
    phoneWarn.textContent = problem ? `⚠ ${problem}` : '';
    phoneWarn.hidden = !problem;
    return problem;
  };
  form0.phone.addEventListener('input', checkPhone);
  checkPhone();
  form0.addEventListener('submit', e => {
    e.preventDefault();
    const d = formData(e.target);
    if (!d.name || !d.phone) return;
    // one confirmation, then it is saved as typed
    if (checkPhone() && !e.target.dataset.confirmed) {
      e.target.dataset.confirmed = '1';
      toast(`${checkPhone()} – לחץ שוב לשמור בכל זאת`, 'warn');
      return;
    }
    if (isEdit) {
      store.updateLead(lead.id, { name: d.name, phone: d.phone, source: d.source, influencer: d.source === INFLUENCER_SOURCE ? d.influencer : '', notes: d.notes, nextAt: d.nextAt || null });
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
    <label class="choice ${DISQUALIFYING.has(r.id) ? 'choice--disq' : ''}">
      <input type="radio" name="reason" value="${r.id}">
      <span>${esc(r.label)}</span>
      ${DISQUALIFYING.has(r.id) ? '<i class="choice__mark" title="לא נספר ככישלון מכירה">∅</i>' : ''}
    </label>`;
  const body = `
    <form class="form" id="lost-form">
      <p class="modal__text">${esc(lead.name)} נמצא בשלב <b>${esc(STAGE_BY_ID[lead.stage].label)}</b>. מה קרה?</p>
      <div class="choices">${relevant.map(radio).join('')}</div>
      <details class="more">
        <summary>סיבות נוספות</summary>
        <div class="choices">${others.map(radio).join('')}</div>
      </details>
      <p class="disq-warn" data-disq hidden>
        <b>שים לב – הסיבה הזו מוציאה את הליד מסטטיסטיקת ההמרה.</b>
        הוא לא ייחשב ככישלון מכירה, כי מלכתחילה לא הייתה כאן עסקה אפשרית.
        בחר בה רק אם זה באמת המצב. מי ששמע אותך ואמר לא – מגיעה לו סיבה אמיתית.
      </p>
      <label class="switch"><input type="checkbox" name="talked" checked><span>דיברתי איתו בטלפון</span></label>
      ${field('הערה (לא חובה)', `<input class="input" name="note" placeholder="למשל: אמר שיחזור אחרי החגים">`)}
    </form>`;
  const m = openModal({
    title: 'סימון ליד כאבוד',
    body,
    footer: `<button class="btn" data-close>ביטול</button><button class="btn btn--danger" type="submit" form="lost-form">סימון כאבוד</button>`,
  });
  const warn = m.el.querySelector('[data-disq]');
  m.el.querySelector('#lost-form').addEventListener('change', e => {
    if (e.target.name !== 'reason') return;
    warn.hidden = !DISQUALIFYING.has(e.target.value);
  });
  m.el.querySelector('#lost-form').addEventListener('submit', e => {
    e.preventDefault();
    const d = formData(e.target);
    if (!d.reason) { toast('בחר סיבה', 'warn'); return; }
    // Ruling someone out on the phone is work, and the day's call count
    // should show it even though nothing was sold.
    if (d.talked) store.logTalk(lead.id);
    store.markLost(lead.id, d.reason, d.note);
    toast(`${lead.name} סומן כאבוד – ${reasonLabel(d.reason)}`);
    m.close();
  });
}

export function openChurnDialog(lead) {
  const relevant = LOST_REASONS.filter(r => r.from.includes('subscribed'));
  const radio = r => `
    <label class="choice">
      <input type="radio" name="reason" value="${r.id}">
      <span>${esc(r.label)}</span>
    </label>`;
  const body = `
    <form class="form" id="churn-form">
      <p class="modal__text">${esc(lead.name)} היה מנוי פעיל. למה הוא הפסיק?</p>
      <div class="choices">${relevant.map(radio).join('')}</div>
      <details class="more">
        <summary>סיבות נוספות</summary>
        <div class="choices">${LOST_REASONS.filter(r => !r.from.includes('subscribed')).map(radio).join('')}</div>
      </details>
      <label class="switch"><input type="checkbox" name="talked" checked><span>דיברתי איתו בטלפון</span></label>
      ${field('הערה (לא חובה)', `<input class="input" name="note" placeholder="למשל: אמר שיחזור אחרי החגים">`)}
    </form>`;
  const m = openModal({
    title: 'הפסקת מנוי',
    body,
    footer: `<button class="btn" data-close>ביטול</button><button class="btn btn--danger" type="submit" form="churn-form">סמן שהמנוי הופסק</button>`,
  });
  m.el.querySelector('#churn-form').addEventListener('submit', e => {
    e.preventDefault();
    const d = formData(e.target);
    if (!d.reason) { toast('בחר סיבה', 'warn'); return; }
    store.markChurned(lead.id, d.reason, d.note);
    toast(`${lead.name} כבר לא מנוי – ${reasonLabel(d.reason)}`);
    m.close();
  });
}

// Sometimes you only find out mid-call that this is not a customer at all
// but somebody to collaborate with. This moves them across without losing
// the phone number or what was already written down.
export function openToInfluencer(lead) {
  const existing = store.getInfluencers().find(i =>
    i.handle.toLowerCase() === handleFrom(lead.name) || (i.phone && i.phone === lead.phone));
  if (existing) { toast(`@${existing.handle} כבר ברשימת המשפיענים`, 'warn'); return; }

  const body = `
    <form class="form" id="to-infl">
      <p class="modal__text">${esc(lead.name)} יעבור מהפייפליין לרשימת המשפיענים.</p>
      ${field('שם משתמש באינסטגרם', `<input class="input" name="handle" required value="${esc(handleFrom(lead.name))}" dir="ltr" autocomplete="off">`, 'זה מה שיקשר אותו ללידים שהוא יביא')}
      ${field('שם', `<input class="input" name="name" value="${esc(lead.name.replace(COLLAB_RE, '').trim())}" autocomplete="off">`)}
      ${field('סטטוס', `<select class="input" name="status">${INFLUENCER_STATUSES.map(st => `<option value="${st.id}">${esc(st.label)}</option>`).join('')}</select>`)}
      ${field('הערות', `<textarea class="input" name="notes" rows="2">${esc(lead.notes || '')}</textarea>`)}
      <label class="switch"><input type="checkbox" name="remove" checked><span>גם להוציא אותו מהפייפליין</span></label>
    </form>`;
  const m = openModal({
    title: 'העברה למשפיענים',
    body,
    footer: `<button class="btn" data-close>ביטול</button><button class="btn btn--primary" type="submit" form="to-infl">העבר</button>`,
  });
  m.el.querySelector('#to-infl').addEventListener('submit', e => {
    e.preventDefault();
    const d = formData(e.target);
    if (!d.handle) { toast('צריך שם משתמש', 'warn'); return; }
    const saved = store.saveInfluencer({ handle: d.handle, name: d.name, phone: lead.phone, status: d.status, notes: d.notes });
    if (!saved) { toast('שם המשתמש לא תקין', 'warn'); return; }
    if (d.remove) store.markLost(lead.id, 'irrelevant', 'הועבר לרשימת המשפיענים');
    m.close();
    closeDrawer();
    toast(`@${saved.handle} עבר למשפיענים`, 'good');
  });
}

// ---- shared actions -----------------------------------------------------
export function advance(lead, to = null) {
  const target = to ? STAGE_BY_ID[to] : nextStage(lead.stage);
  if (!target) return;
  store.advanceLead(lead.id, target.id);
  toast(target.id === FINAL_STAGE ? `🎉 ${lead.name} סגר מנוי!` : `${lead.name} → ${target.label}`, target.id === FINAL_STAGE ? 'good' : '');
}
export function attempt(lead) {
  store.logAttempt(lead.id, 'call');
  toast(`נרשם ניסיון ללא מענה · ננסה שוב מחר`);
}
export function restore(lead) {
  store.restoreLead(lead.id);
  toast(`${lead.name} חזר לפייפליין`, 'good');
}
// Tapping a step in the drawer moves the lead there, in either direction.
export function goToStage(lead, stageId) {
  const target = STAGE_BY_ID[stageId];
  if (!target || (lead.stage === stageId && lead.status === 'active')) return;
  if (lead.nextAt) store.setNextAt(lead.id, null);
  store.moveToStage(lead.id, stageId);
  toast(`${lead.name} → ${target.label}`);
}

export function subscribeNow(lead) {
  store.advanceLead(lead.id, FINAL_STAGE);
  toast(`🎉 ${lead.name} סגר מנוי!`, 'good');
}
export async function remove(lead) {
  const ok = await confirmDialog({ title: 'מחיקת ליד', text: `למחוק את ${lead.name} לצמיתות? הפעולה לא ניתנת לביטול.`, okLabel: 'מחיקה', danger: true });
  if (ok) { store.deleteLead(lead.id); toast('הליד נמחק'); closeDrawer(); }
}

// Buttons that appear on cards and in the drawer.
export function actionButtons(lead, { compact = false } = {}) {
  if (lead.status === 'lost' || lead.status === 'churned') {
    return `<button class="btn btn--sm" data-act="restore" data-id="${lead.id}">↩ החזר לפייפליין</button>`;
  }
  if (lead.status === 'won') {
    return `
      <span class="won-tag">✓ מנוי פעיל</span>
      <button class="btn btn--sm btn--ghost btn--lost" data-act="churn" data-id="${lead.id}" title="המנוי הופסק">ביטל מנוי</button>`;
  }
  const next = nextStage(lead.stage);
  const canAttempt = ['new', 'followup', 'pitched', 'delivered', 'repeat'].includes(lead.stage);
  // Before the trial is paid for, the sales call is the thing to do next.
  const needsScript = ['new', 'followup', 'pitched'].includes(lead.stage);
  const doneScript = Boolean(lead.scripts?.sales?.completedAt);
  if (needsScript) {
    return `
      <button class="btn btn--sm btn--primary" data-act="script" data-id="${lead.id}">${doneScript ? '↻ פתח תסריט' : '▶ שיחת מכירה'}</button>
      ${doneScript && lead.stage !== 'pitched' ? `<button class="btn btn--sm" data-act="advance" data-to="pitched" data-id="${lead.id}">✓ בוצעה שיחת מכירה</button>` : ''}
      ${doneScript && lead.stage === 'pitched' ? `<button class="btn btn--sm" data-act="advance" data-to="trial" data-id="${lead.id}">✓ סגר שבוע ניסיון</button>` : ''}
      <button class="btn btn--sm btn--ghost" data-act="attempt" data-id="${lead.id}" title="נרשם ניסיון, ננסה שוב מחר">לא ענה</button>
      <button class="btn btn--sm btn--ghost btn--lost" data-act="lost" data-id="${lead.id}" title="סימון כאבוד">✕${compact ? '' : ' אבד'}</button>`;
  }
  // From the delivery onwards there are two good outcomes — another single
  // week, or the subscription itself — so both are one click away.
  const skipToSub = ['delivered', 'repeat'].includes(lead.stage) && next.id !== FINAL_STAGE;
  return `
    <button class="btn btn--sm btn--primary" data-act="advance" data-id="${lead.id}" title="${esc(next.label)}">✓ ${esc(next.action)}</button>
    ${skipToSub ? `<button class="btn btn--sm" data-act="subscribe" data-id="${lead.id}" title="דילוג ישר למנוי">סגר מנוי</button>` : ''}
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
    case 'advance': advance(lead, b.dataset.to || null); break;
    case 'attempt': attempt(lead); break;
    case 'lost': openLostDialog(lead); break;
    case 'churn': openChurnDialog(lead); break;
    case 'script': openScript(lead.id, 'sales'); break;
    case 'to-influencer': openToInfluencer(lead); break;
    case 'subscribe': subscribeNow(lead); break;
    case 'goto': goToStage(lead, b.dataset.to); break;
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

// What the sales call turned up, kept in front of you — the conversion
// script explicitly asks for the customer's goal, and this is where it is.
function scriptPanel(lead) {
  const a = lead.scripts?.sales;
  if (!a) return '';
  const rows = visibleFields(SALES_SCRIPT, a)
    .map(f => [f.ask, String(a[f.id] ?? '').trim()])
    .filter(([, v]) => v);
  if (!rows.length) return '';
  return `
    <section class="drawer__script">
      <h3>מה למדנו בשיחת המכירה${a.completedAt ? '' : ' (לא הושלמה)'}</h3>
      <dl class="learned">
        ${rows.map(([q, v]) => `<div><dt>${esc(q)}</dt><dd>${esc(v)}</dd></div>`).join('')}
      </dl>
      <button class="btn btn--sm" data-act="script" data-id="${lead.id}">פתח את התסריט</button>
    </section>`;
}

function renderDrawer() {
  const panel = drawerEl.querySelector('.drawer__panel');
  preserve(panel, () => paintDrawer(panel));
}

function paintDrawer(panel) {
  const lead = store.getLead(drawerId);
  if (!lead) { panel.innerHTML = `<div class="empty">הליד לא נמצא</div>`; return; }
  const idx = stageIndex(lead.stage);
  const days = daysBetween(lead.createdAt, new Date());
  const lastEvent = lead.events[lead.events.length - 1];
  const stageSince = [...lead.events].reverse().find(e => e.type === 'advanced' || e.type === 'created');
  const inStage = stageSince ? daysBetween(stageSince.t, new Date()) : 0;

  const stepper = STAGES.map((s, i) => {
    const cls = i < idx ? 'is-done'
      : i === idx ? (lead.status === 'lost' || lead.status === 'churned' ? 'is-lost' : lead.status === 'won' ? 'is-won' : 'is-current')
      : '';
    const here = i === idx && lead.status === 'active';
    return `<li class="stepper__step ${cls}">
      <button class="stepper__hit" data-act="goto" data-to="${s.id}" data-id="${lead.id}"
        title="${here ? esc(s.label) : 'העברה ל' + esc(s.label)}" ${here ? 'disabled' : ''}>
        <span class="stepper__dot"></span><span class="stepper__label">${esc(s.short)}</span>
      </button>
    </li>`;
  }).join('');

  const timeline = [...lead.events].reverse().map(ev => {
    let text = EVENT_LABELS[ev.type] || ev.type;
    if (ev.type === 'advanced') text = STAGE_BY_ID[ev.stage]?.done || text;
    if (ev.type === 'lost') text = `סומן כאבוד · ${reasonLabel(ev.reason)}`;
    if (ev.type === 'churned') text = `המנוי הופסק · ${reasonLabel(ev.reason)}`;
    if (ev.type === 'moved') text = `הועבר ל${STAGE_BY_ID[ev.stage]?.label || ''}`;
    if (ev.type === 'attempt') text = `ניסיון ${ev.channel === 'whatsapp' ? 'בוואטסאפ' : 'טלפוני'} ללא מענה`;
    if (ev.type === 'talked') text = 'שיחה טלפונית';
    if (ev.type === 'note') text = ev.text;
    return `<li class="tl__item tl__item--${ev.type}">
      <span class="tl__dot"></span>
      <div class="tl__body"><div class="tl__text">${esc(text)}${ev.type === 'lost' && ev.text ? `<div class="tl__note">"${esc(ev.text)}"</div>` : ''}</div><time class="tl__time">${fmtDateTime(ev.t)}</time></div>
    </li>`;
  }).join('');

  const statusTag = lead.status === 'won' ? `<span class="tag tag--won">מנוי פעיל</span>`
    : lead.status === 'churned' ? `<span class="tag tag--churn">היה מנוי והפסיק · ${esc(reasonLabel(lead.lostReason))}</span>`
    : lead.status === 'lost' ? `<span class="tag tag--lost">אבד · ${esc(reasonLabel(lead.lostReason))}</span>`
    : `<span class="tag tag--active">${esc(STAGE_BY_ID[lead.stage].label)}</span>`;

  panel.innerHTML = `
    <header class="drawer__head">
      <button class="icon-btn" data-close-drawer aria-label="סגירה">✕</button>
      <div>
        <h2 class="drawer__name">${esc(lead.name)}</h2>
        <div class="drawer__sub">${statusTag}<span class="muted">נכנס ${fmtDateLong(lead.createdAt)} · ${esc(lead.source)}${lead.influencer ? ' · ' + esc(lead.influencer) : ''}</span></div>
      </div>
    </header>
    <div class="drawer__contact">
      <a class="contact contact--tel" href="${telLink(lead.phone)}">📞 ${esc(fmtPhone(lead.phone))}</a>
      ${copyBtn(lead.phone)}
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
    ${scriptPanel(lead)}
    <div class="drawer__fields">
      ${field('פעולה הבאה', `<input class="input" type="date" name="nextAt" value="${esc(lead.nextAt || '')}" min="">`, lead.nextAt ? dueLabel(lead.nextAt) : '')}
      ${field('הערות', `<textarea class="input" name="notes" rows="3" placeholder="הערות קבועות על הליד">${esc(lead.notes || '')}</textarea>`)}
    </div>
    <section class="drawer__timeline">
      <h3>היסטוריה</h3>
      <form id="note-form" class="note-form"><input class="input" placeholder="הוסף הערה להיסטוריה…" autocomplete="off"><button class="btn btn--sm" type="submit">הוסף</button></form>
      <ol class="tl">${timeline}</ol>
    </section>
    <footer class="drawer__foot">
      <button class="btn btn--sm" data-act="to-influencer" data-id="${lead.id}">⤴ העבר למשפיענים</button>
      <button class="btn btn--sm btn--ghost btn--lost" data-act="delete" data-id="${lead.id}">מחיקת הליד</button>
    </footer>`;
}
