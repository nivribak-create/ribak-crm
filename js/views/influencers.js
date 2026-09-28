// Influencer partnerships — who we want to work with, who we already
// approached, and which collaboration actually produced subscribers.
// Leads tagged with an influencer's handle feed each card's numbers, so a
// collaboration is judged by customers rather than by reach.

import { INFLUENCER_STATUSES, INFLUENCER_STATUS_BY_ID, INFLUENCER_SOURCE, everSubscribed, stageIndex } from '../model.js';
import * as store from '../store.js';
import { openModal, confirmDialog, toast, field, formData } from '../ui.js';
import { esc, fmtNum, pct1, relDays } from '../util.js';

export function render(root, state) {
  const list = store.getInfluencers();
  const stats = statsByHandle(state.leads);
  const cols = INFLUENCER_STATUSES.map(s => ({ status: s, items: list.filter(i => i.status === s.id) }));
  const totals = list.reduce((acc, i) => {
    const s = stats[key(i.handle)];
    if (s) { acc.leads += s.total; acc.won += s.won; }
    return acc;
  }, { leads: 0, won: 0 });

  root.innerHTML = `
    <div class="toolbar">
      <button class="btn btn--primary" data-add>+ משפיען</button>
      <span class="toolbar__note muted">
        ${fmtNum(list.length)} ברשימה${totals.leads ? ` · הביאו ${fmtNum(totals.leads)} לידים ו-${fmtNum(totals.won)} מנויים` : ''}
      </span>
    </div>

    ${list.length ? '' : `
      <div class="hero-empty">
        <h2>רשימת המשפיענים ריקה</h2>
        <p>הוסף משפיענים שאתה רוצה לעבוד איתם, ועקוב אחרי הפנייה, המשא ומתן, ובסוף – כמה מנויים כל אחד באמת הביא.</p>
        <div class="hero-empty__actions"><button class="btn btn--primary" data-add>+ המשפיען הראשון</button></div>
      </div>`}

    <div class="board board--infl">
      ${cols.map(c => column(c, stats)).join('')}
    </div>`;

  root.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => openForm()));
  root.onclick = e => {
    if (e.target.closest('a')) { e.stopPropagation(); return; }
    const move = e.target.closest('[data-move]');
    if (move) {
      e.stopPropagation();
      store.setInfluencerStatus(move.dataset.id, move.dataset.move);
      return;
    }
    const card = e.target.closest('.icard');
    if (card) openForm(store.getInfluencers().find(i => i.id === card.dataset.id));
  };
}

const key = h => String(h || '').trim().replace(/^@/, '').toLowerCase();

// Leads carry the influencer handle as free text, so match case-insensitively
// and ignore a leading @ either side.
function statsByHandle(leads) {
  const out = {};
  for (const l of leads) {
    if (!l.influencer) continue;
    const k = key(l.influencer);
    const s = out[k] || (out[k] = { total: 0, trial: 0, won: 0 });
    s.total++;
    if (stageIndex(l.stage) >= stageIndex('trial')) s.trial++;
    if (everSubscribed(l)) s.won++;
  }
  return out;
}

function column({ status, items }, stats) {
  return `<section class="col col--infl col--${status.id}" aria-label="${esc(status.label)}">
    <header class="col__head">
      <span class="col__dot"></span>
      <h2 class="col__title">${esc(status.label)}</h2>
      <span class="col__count">${fmtNum(items.length)}</span>
    </header>
    <div class="col__body">
      ${items.length ? items.map(i => card(i, stats[key(i.handle)])).join('') : '<div class="col__empty">ריק</div>'}
    </div>
  </section>`;
}

function card(inf, s) {
  const idx = INFLUENCER_STATUSES.findIndex(x => x.id === inf.status);
  const next = INFLUENCER_STATUSES[idx + 1];
  const conv = s && s.total ? pct1(s.won, s.total) : 0;
  return `<article class="card icard" data-id="${inf.id}" tabindex="0">
    <div class="card__top">
      <b class="card__name">@${esc(inf.handle)}</b>
      ${inf.followers ? `<span class="card__source">${esc(inf.followers)}</span>` : ''}
    </div>
    ${inf.name ? `<div class="card__row muted">${esc(inf.name)}</div>` : ''}
    ${s ? `
      <div class="icard__stats">
        <div><b>${fmtNum(s.total)}</b><span>לידים</span></div>
        <div><b>${fmtNum(s.trial)}</b><span>ניסיון</span></div>
        <div><b>${fmtNum(s.won)}</b><span>מנוי</span></div>
        <div><b class="${conv >= 10 ? 'good' : ''}">${conv}%</b><span>המרה</span></div>
      </div>`
    : (inf.status === 'active' ? '<div class="card__row muted">עוד לא הגיעו לידים מתויגים</div>' : '')}
    ${inf.notes ? `<p class="card__notes">${esc(inf.notes)}</p>` : ''}
    <div class="card__actions">
      ${next ? `<button class="btn btn--sm btn--primary" data-move="${next.id}" data-id="${inf.id}">→ ${esc(next.short)}</button>` : ''}
      ${inf.status !== 'rejected' ? `<button class="btn btn--sm btn--ghost btn--lost" data-move="rejected" data-id="${inf.id}">לא יצא</button>` : ''}
    </div>
  </article>`;
}

function openForm(inf = null) {
  const isEdit = Boolean(inf);
  const body = `
    <form class="form" id="infl-form">
      ${field('שם משתמש באינסטגרם', `<input class="input" name="handle" required value="${esc(inf?.handle || '')}" placeholder="noa_fit" autocomplete="off" dir="ltr">`, 'בלי @ – זה מה שמקשר בין המשפיען ללידים שהוא מביא')}
      ${field('שם', `<input class="input" name="name" value="${esc(inf?.name || '')}" placeholder="נועה כהן" autocomplete="off">`)}
      ${field('עוקבים', `<input class="input" name="followers" value="${esc(inf?.followers || '')}" placeholder="45K" autocomplete="off">`)}
      ${field('סטטוס', `<select class="input" name="status">${INFLUENCER_STATUSES.map(s => `<option value="${s.id}" ${inf?.status === s.id ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>`)}
      ${field('הערות', `<textarea class="input" name="notes" rows="3" placeholder="מה סוכם, כמה ביקש, מתי לחזור אליו">${esc(inf?.notes || '')}</textarea>`)}
    </form>`;
  const m = openModal({
    title: isEdit ? `@${inf.handle}` : 'משפיען חדש',
    body,
    footer: `
      ${isEdit ? '<button class="btn btn--danger-ghost" data-del>מחיקה</button>' : ''}
      <button class="btn" data-close>ביטול</button>
      <button class="btn btn--primary" type="submit" form="infl-form">${isEdit ? 'שמירה' : 'הוספה'}</button>`,
  });
  m.el.querySelector('#infl-form').addEventListener('submit', e => {
    e.preventDefault();
    const d = formData(e.target);
    if (!d.handle) return;
    const saved = store.saveInfluencer({ ...(inf || {}), ...d });
    if (!saved) { toast('צריך שם משתמש', 'warn'); return; }
    toast(isEdit ? 'נשמר' : `@${saved.handle} נוסף לרשימה`, 'good');
    m.close();
  });
  m.el.querySelector('[data-del]')?.addEventListener('click', async () => {
    m.close();
    if (await confirmDialog({ title: 'מחיקת משפיען', text: `למחוק את @${inf.handle} מהרשימה? הלידים שהוא הביא יישארו.`, okLabel: 'מחיקה', danger: true })) {
      store.deleteInfluencer(inf.id);
      toast('נמחק');
    }
  });
}
