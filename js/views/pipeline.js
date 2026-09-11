import { STAGES, STAGE_BY_ID, stageIndex, reasonLabel, FINAL_STAGE } from '../model.js';
import { esc, fmtPhone, waLink, telLink, daysBetween, dueLabel, relDays, fmtNum } from '../util.js';
import { actionButtons, handleAction, openDrawer } from '../lead.js';

const ui = {
  q: '',
  showLost: sessionStorage.getItem('ribak:showLost') === '1',
};

function boardHtml(state, today) {
  const q = ui.q.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  const match = l => !q || l.name.toLowerCase().includes(q) || (qDigits && l.phone.replace(/\D/g, '').includes(qDigits)) || (l.notes || '').toLowerCase().includes(q);
  const leads = state.leads.filter(match);
  const cols = STAGES.map(s => ({
    stage: s,
    leads: leads.filter(l => l.stage === s.id && l.status !== 'lost').sort((a, b) => sortKey(a, today) - sortKey(b, today)),
  }));
  const lostLeads = leads.filter(l => l.status === 'lost').sort((a, b) => (a.lostAt < b.lostAt ? 1 : -1));
  return {
    html: cols.map(c => column(c, today)).join('') + (ui.showLost ? lostColumn(lostLeads) : ''),
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
      <label class="switch"><input type="checkbox" data-showlost ${ui.showLost ? 'checked' : ''}><span>הצג אבודים (<span data-lost-count>${fmtNum(b.lostCount)}</span>)</span></label>
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
    if (handleAction(e)) return;
    const card = e.target.closest('.card');
    if (card) openDrawer(card.dataset.id);
  };
  root.onkeydown = e => {
    if (e.key === 'Enter' && e.target.classList.contains('card')) openDrawer(e.target.dataset.id);
  };
}

function sortKey(l, today) {
  // overdue first, then due today, then oldest in stage
  if (l.nextAt) { const d = daysBetween(today, l.nextAt); if (d <= 0) return d - 1000; return d; }
  return 500 - daysBetween(l.createdAt, today) / 1000;
}

function column({ stage, leads }, today) {
  const idx = stageIndex(stage.id);
  const isFinal = stage.id === FINAL_STAGE;
  return `<section class="col" style="--stage:${idx}" aria-label="${esc(stage.label)}">
    <header class="col__head">
      <span class="col__dot"></span>
      <h2 class="col__title">${esc(stage.label)}</h2>
      <span class="col__count">${fmtNum(leads.length)}</span>
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
  return `<article class="card ${isFinal ? 'card--won' : ''} ${dueCls}" data-id="${l.id}" tabindex="0">
    <div class="card__top">
      <b class="card__name">${esc(l.name)}</b>
      <span class="card__source">${esc(l.source)}</span>
    </div>
    <div class="card__meta">
      <a class="card__phone" href="${telLink(l.phone)}">${esc(fmtPhone(l.phone))}</a>
      <a class="card__wa" href="${waLink(l.phone)}" target="_blank" rel="noopener" title="פתח בוואטסאפ">וואטסאפ</a>
    </div>
    <div class="card__row">
      <span class="muted">${inStage === 0 ? 'היום' : `${inStage} ${inStage === 1 ? 'יום' : 'ימים'} בשלב`}</span>
      ${l.attempts ? `<span class="tag tag--warn" title="ניסיונות ללא מענה">${l.attempts} ללא מענה</span>` : ''}
      ${l.nextAt ? `<span class="tag ${due < 0 ? 'tag--lost' : due === 0 ? 'tag--warn' : ''}">${esc(dueLabel(l.nextAt))}</span>` : ''}
    </div>
    ${l.notes ? `<p class="card__notes">${esc(l.notes)}</p>` : ''}
    ${isFinal ? '' : `<div class="card__actions">${actionButtons(l, { compact: true })}</div>`}
  </article>`;
}

function lostColumn(leads) {
  return `<section class="col col--lost" aria-label="אבודים">
    <header class="col__head">
      <span class="col__dot"></span>
      <h2 class="col__title">אבודים</h2>
      <span class="col__count">${fmtNum(leads.length)}</span>
    </header>
    <div class="col__body">
      ${leads.length ? leads.map(l => `<article class="card card--lost" data-id="${l.id}" tabindex="0">
        <div class="card__top"><b class="card__name">${esc(l.name)}</b><span class="card__source">${esc(l.source)}</span></div>
        <div class="card__row"><span class="tag tag--lost">${esc(reasonLabel(l.lostReason))}</span></div>
        <div class="card__row muted">בשלב ${esc(STAGE_BY_ID[l.stage].short)} · ${relDays(l.lostAt)}</div>
        <div class="card__actions">${actionButtons(l)}</div>
      </article>`).join('') : `<div class="col__empty">אין לידים אבודים</div>`}
    </div>
  </section>`;
}
