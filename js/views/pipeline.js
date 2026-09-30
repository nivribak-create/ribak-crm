import { STAGES, STAGE_BY_ID, stageIndex, reasonLabel, FINAL_STAGE } from '../model.js';
import { esc, fmtPhone, waLink, telLink, daysBetween, dueLabel, relDays, fmtNum, isParked, parseDay, fmtDateLong, endOfWeek, isoDay, addDays } from '../util.js';
import { actionButtons, handleAction, openDrawer, openLostDialog } from '../lead.js';
import { copyBtn, toast, openModal, field, formData, openMenu } from '../ui.js';
import { installDrag } from '../dnd.js';
import * as store from '../store.js';

const ui = {
  q: '',
  showLost: sessionStorage.getItem('ribak:showLost') === '1',
};

function boardHtml(state, today) {
  const q = ui.q.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  const match = l => !q || l.name.toLowerCase().includes(q) || (qDigits && l.phone.replace(/\D/g, '').includes(qDigits)) || (l.notes || '').toLowerCase().includes(q);
  const leads = state.leads.filter(match);
  // Anyone due back after this week waits off to the side until their day.
  const parked = leads.filter(isParked).sort((a, b) => (a.nextAt < b.nextAt ? -1 : 1));
  const onBoard = leads.filter(l => !isParked(l));
  const cols = STAGES.map(s => ({
    stage: s,
    leads: onBoard.filter(l => l.stage === s.id && l.status !== 'lost' && l.status !== 'churned')
      .sort((a, b) => sortKey(a, today) - sortKey(b, today)),
  }));
  const lostLeads = onBoard.filter(l => l.status === 'lost' || l.status === 'churned').sort((a, b) => (a.lostAt < b.lostAt ? 1 : -1));
  return {
    html: cols.map(c => column(c, today)).join('') + futureColumn(parked) + (ui.showLost ? lostColumn(lostLeads) : ''),
    lostCount: lostLeads.length,
    activeCount: leads.filter(l => l.status === 'active').length,
  };
}

export function render(root, state) {
  const today = new Date();
  const b = boardHtml(state, today);

  root.innerHTML = `
    <div class="toolbar">
      <input class="input input--sm input--search" type="search" placeholder="חיפוש לפי שם או טלפון" value="${esc(ui.q)}" data-q aria-label="חיפוש">
      <label class="switch"><input type="checkbox" data-showlost ${ui.showLost ? 'checked' : ''}><span>הצג אבודים והפסיקו (<span data-lost-count>${fmtNum(b.lostCount)}</span>)</span></label>
      <span class="toolbar__note muted"><span data-active-count>${fmtNum(b.activeCount)}</span> בטיפול</span>
    </div>
    <div class="board ${ui.showLost ? 'board--with-lost' : ''}">${b.html}</div>`;

  root.querySelector('[data-q]').addEventListener('input', e => {
    ui.q = e.target.value;
    const board = root.querySelector('.board');
    const scroll = board.scrollLeft;
    const nb = boardHtml(state, new Date());
    board.innerHTML = nb.html;
    board.scrollLeft = scroll;
    root.querySelector('[data-lost-count]').textContent = fmtNum(nb.lostCount);
    root.querySelector('[data-active-count]').textContent = fmtNum(nb.activeCount);
  });
  root.querySelector('[data-showlost]').addEventListener('change', e => {
    ui.showLost = e.target.checked; sessionStorage.setItem('ribak:showLost', ui.showLost ? '1' : '0'); render(root, state);
  });
  root.onclick = e => {
    if (e.target.closest('a')) { e.stopPropagation(); return; }
    const mv = e.target.closest('[data-move-menu]');
    if (mv) { e.stopPropagation(); openStageMenu(mv.dataset.moveMenu, mv); return; }
    if (handleAction(e)) return;
    const card = e.target.closest('.card');
    if (card) openDrawer(card.dataset.id);
  };
  root.onkeydown = e => {
    if (e.key === 'Enter' && e.target.classList.contains('card')) openDrawer(e.target.dataset.id);
  };

  installDrag(root.querySelector('.board'), { onDrop: drop });
}

// Dropping onto the lost column needs a reason, and dropping a lost lead
// back onto a stage puts it back in play.
function drop(id, stage) {
  const lead = store.getLead(id);
  if (!lead) return;
  if (stage === '__lost') {
    if (lead.status === 'lost' || lead.status === 'churned') return;
    openLostDialog(lead);
    return;
  }
  if (stage === '__future') { openParkDialog(lead); return; }
  // pulling one back out of the waiting area means dealing with it now
  if (isParked(lead)) store.setNextAt(id, null);
  if (lead.stage !== stage) store.moveToStage(id, stage);
  toast(`${lead.name} → ${STAGE_BY_ID[stage].label}`);
}

// Picking the stage from a list beats dragging a card to a column that is
// usually off-screen — same result, one tap, and it works the same on a
// phone.
export function openStageMenu(id, anchor) {
  const lead = store.getLead(id);
  if (!lead) return;
  const parked = isParked(lead);
  const items = STAGES.map((st, i) => ({
    label: st.label,
    value: st.id,
    swatch: `var(--f${i})`,
    current: st.id === lead.stage && !parked,
    hint: st.id === lead.stage && parked ? 'כאן הוא יחזור' : '',
  }));
  items.push({ separator: true });
  items.push(parked
    ? { label: 'החזר לעבודה עכשיו', value: '__unpark' }
    : { label: 'פולואפ עתידי…', value: '__future' });
  if (lead.status === 'active') items.push({ label: 'סימון כאבוד…', value: '__lost', danger: true });

  openMenu(anchor, items, item => {
    if (!item || item.current) return;
    if (item.value === '__unpark') { store.setNextAt(id, null); toast(`${lead.name} חזר לעבודה`); return; }
    drop(id, item.value);
  });
}

// Parking needs a date, so ask for one rather than invent it.
function openParkDialog(lead) {
  const earliest = isoDay(addDays(endOfWeek(), 1));
  const m = openModal({
    title: 'פולואפ עתידי',
    body: `
      <form class="form" id="park-form">
        <p class="modal__text">מתי לחזור אל ${esc(lead.name)}? עד אז הוא ימתין בצד ולא יופיע בלוח.</p>
        ${field('תאריך', `<input class="input" type="date" name="nextAt" required value="${esc(isoDay(addDays(endOfWeek(), 2)))}" min="${esc(earliest)}">`, `חייב להיות אחרי ${fmtDateLong(endOfWeek().toISOString())}`)}
      </form>`,
    footer: `<button class="btn" data-close>ביטול</button><button class="btn btn--primary" type="submit" form="park-form">שמור</button>`,
  });
  m.el.querySelector('#park-form').addEventListener('submit', e => {
    e.preventDefault();
    const { nextAt } = formData(e.target);
    if (!nextAt) return;
    store.setNextAt(lead.id, nextAt);
    m.close();
    toast(`${lead.name} יחזור ב-${fmtDateLong(parseDay(nextAt).toISOString())}`);
  });
}

// A lead you have already touched today has had its turn, so it sinks to
// the bottom of its column and the top of the board is always the work
// still waiting.
function handledToday(l, today) {
  const last = l.events[l.events.length - 1];
  if (!last || last.type === 'created' || last.type === 'imported') return false;
  return daysBetween(last.t, today) === 0;
}

function sortKey(l, today) {
  if (handledToday(l, today)) {
    // among those, the one touched longest ago comes first
    return 10000 - (Date.now() - new Date(l.events[l.events.length - 1].t)) / 3.6e6;
  }
  // overdue first, then due today, then oldest in stage
  if (l.nextAt) { const d = daysBetween(today, l.nextAt); if (d <= 0) return d - 1000; return d; }
  return 500 - daysBetween(l.createdAt, today) / 1000;
}

function column({ stage, leads }, today) {
  const idx = stageIndex(stage.id);
  const isFinal = stage.id === FINAL_STAGE;
  const waiting = leads.filter(l => !handledToday(l, today)).length;
  return `<section class="col" style="--stage:${idx}" data-stage="${stage.id}" aria-label="${esc(stage.label)}">
    <header class="col__head">
      <span class="col__dot"></span>
      <h2 class="col__title">${esc(stage.label)}</h2>
      <span class="col__count">${fmtNum(leads.length)}</span>
      ${waiting !== leads.length ? `<span class="col__waiting" title="עוד לא טופלו היום">${fmtNum(waiting)} ממתינים</span>` : ''}
    </header>
    <div class="col__body">
      ${leads.length ? leads.map(l => card(l, today, isFinal)).join('') : `<div class="col__empty">${isFinal ? 'עוד לא נסגרו מנויים' : 'ריק'}</div>`}
    </div>
  </section>`;
}

function card(l, today, isFinal) {
  const since = [...l.events].reverse().find(e => e.type === 'advanced' || e.type === 'created');
  const inStage = since ? daysBetween(since.t, today) : 0;
  const due = l.nextAt ? daysBetween(today, l.nextAt) : null;
  const dueCls = due == null ? '' : due < 0 ? 'is-late' : due === 0 ? 'is-today' : '';
  const done = handledToday(l, today);
  return `<article class="card ${isFinal ? 'card--won' : ''} ${dueCls} ${done ? 'is-handled' : ''}" data-id="${l.id}" tabindex="0">
    <div class="card__top">
      <b class="card__name">${esc(l.name)}</b>
      <span class="card__source">${esc(l.source)}</span>
      <button class="card__move" data-move-menu="${l.id}" title="העברה לשלב אחר" aria-label="העברה לשלב אחר">⇄</button>
    </div>
    <div class="card__meta">
      <span class="card__phone-wrap">
        <a class="card__phone" href="${telLink(l.phone)}">${esc(fmtPhone(l.phone))}</a>
        ${copyBtn(l.phone)}
      </span>
      <a class="card__wa" href="${waLink(l.phone)}" target="_blank" rel="noopener" title="פתח בוואטסאפ">וואטסאפ</a>
    </div>
    <div class="card__row">
      <span class="muted">${inStage === 0 ? 'היום' : `${inStage} ${inStage === 1 ? 'יום' : 'ימים'} בשלב`}</span>
      ${l.attempts ? `<span class="tag tag--warn" title="ניסיונות ללא מענה">${l.attempts} ללא מענה</span>` : ''}
      ${l.nextAt ? `<span class="tag ${due < 0 ? 'tag--lost' : due === 0 ? 'tag--warn' : ''}">${esc(dueLabel(l.nextAt))}</span>` : ''}
      ${done ? '<span class="tag tag--done">✓ טופל היום</span>' : ''}
    </div>
    ${l.notes ? `<p class="card__notes">${esc(l.notes)}</p>` : ''}
    ${isFinal ? '' : `<div class="card__actions">${actionButtons(l, { compact: true })}</div>`}
  </article>`;
}

// Everyone due back after this week. The lead keeps the stage it is really
// on — this is only where it is shown — so when the date arrives it
// reappears exactly where it left off.
function futureColumn(leads) {
  const until = fmtDateLong(endOfWeek().toISOString());
  return `<section class="col col--future" data-stage="__future" aria-label="פולואפ עתידי">
    <header class="col__head">
      <span class="col__dot"></span>
      <h2 class="col__title">פולואפ עתידי</h2>
      <span class="col__count">${fmtNum(leads.length)}</span>
      <span class="col__waiting">לחזור אחרי ${esc(until)}</span>
    </header>
    <div class="col__body">
      ${leads.length ? leads.map(futureCard).join('')
        : '<div class="col__empty">מי שתסמן לחזור אליו בשבוע הבא ואילך יופיע כאן</div>'}
    </div>
  </section>`;
}

function futureCard(l) {
  const days = daysBetween(new Date(), l.nextAt);
  return `<article class="card card--future" data-id="${l.id}" tabindex="0" style="--c:var(--f${stageIndex(l.stage)})">
    <div class="card__top">
      <b class="card__name">${esc(l.name)}</b>
      <span class="card__source">${esc(l.source)}</span>
      <button class="card__move" data-move-menu="${l.id}" title="העברה לשלב אחר" aria-label="העברה לשלב אחר">⇄</button>
    </div>
    <div class="card__meta">
      <span class="card__phone-wrap">
        <a class="card__phone" href="${telLink(l.phone)}">${esc(fmtPhone(l.phone))}</a>
        ${copyBtn(l.phone)}
      </span>
      <a class="card__wa" href="${waLink(l.phone)}" target="_blank" rel="noopener">וואטסאפ</a>
    </div>
    <div class="future__when">
      <b>${esc(fmtDateLong(parseDay(l.nextAt).toISOString()))}</b>
      <span>בעוד ${fmtNum(days)} ${days === 1 ? 'יום' : 'ימים'}</span>
    </div>
    <div class="card__row muted">יחזור ל${esc(STAGE_BY_ID[l.stage].label)}</div>
    ${l.notes ? `<p class="card__notes">${esc(l.notes)}</p>` : ''}
  </article>`;
}

function lostColumn(leads) {
  return `<section class="col col--lost" data-stage="__lost" aria-label="אבודים">
    <header class="col__head">
      <span class="col__dot"></span>
      <h2 class="col__title">אבדו / הפסיקו</h2>
      <span class="col__count">${fmtNum(leads.length)}</span>
    </header>
    <div class="col__body">
      ${leads.length ? leads.map(l => `<article class="card card--lost" data-id="${l.id}" tabindex="0">
        <div class="card__top">
          <b class="card__name">${esc(l.name)}</b>
          <span class="card__source">${esc(l.source)}</span>
          <button class="card__move" data-move-menu="${l.id}" title="העברה לשלב אחר" aria-label="העברה לשלב אחר">⇄</button>
        </div>
        <div class="card__row"><span class="tag tag--${l.status === 'churned' ? 'churn' : 'lost'}">${l.status === 'churned' ? 'הפסיק מנוי · ' : ''}${esc(reasonLabel(l.lostReason))}</span></div>
        <div class="card__row muted">בשלב ${esc(STAGE_BY_ID[l.stage].short)} · ${relDays(l.lostAt)}</div>
        <div class="card__actions">${actionButtons(l)}</div>
      </article>`).join('') : `<div class="col__empty">אין לידים אבודים</div>`}
    </div>
  </section>`;
}
