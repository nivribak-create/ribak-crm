import { STAGES, STAGE_BY_ID, stageIndex, reasonLabel, FINAL_STAGE, lastAction, onColdBoard, deliveryWeek, adLabel, lastNudge, lastOrder, inRounds, dueForRound, firstName, roundAnswer, ROUND_GAP_DAYS } from '../model.js';
import { esc, fmtPhone, waLink, telLink, daysBetween, dueLabel, relDays, fmtNum, dueLater, parseDay, fmtDateLong, fmtDate, isoDay, addDays, sundayOf, normPhone } from '../util.js';
import { actionButtons, handleAction, openDrawer, openLostDialog } from '../lead.js';
import { copyBtn, toast, openModal, field, formData, openMenu, copyToClipboard } from '../ui.js';
import { installDrag } from '../dnd.js';
import * as store from '../store.js';
import { readFile } from '../import.js';
import { downloadXlsx } from '../xlsx-write.js';

// Two boards off one piece of code: the main one, and the cold leads an
// influencer's link brought in, which are a different job — a queue to work
// through rather than customers moving along.
const COHORTS = {
  warm: {
    belongs: l => !onColdBoard(l),
    stages: STAGES,
    note: () => 'לידים שפנו אליך',
  },
  cold: {
    belongs: onColdBoard,
    stages: STAGES.slice(0, stageIndex('trial')),
    note: n => `${fmtNum(n)} לידים קרים מהמגנט · מי שסוגר שבוע ניסיון עובר לפייפליין הראשי`,
  },
};

const ui = {
  q: '',
  cohort: 'warm',
  showLost: sessionStorage.getItem('ribak:showLost') === '1',
};

function boardHtml(state, today) {
  const cohort = COHORTS[ui.cohort];
  const q = ui.q.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  const match = l => !q || l.name.toLowerCase().includes(q) || (qDigits && l.phone.replace(/\D/g, '').includes(qDigits)) || (l.notes || '').toLowerCase().includes(q);
  const leads = state.leads.filter(cohort.belongs).filter(match);
  // Anyone due back on a later day waits off to the side until their day.
  const parked = leads.filter(dueLater).sort((a, b) => (a.nextAt < b.nextAt ? -1 : 1));
  const onBoard = leads.filter(l => !dueLater(l));
  const cols = cohort.stages.map(s => ({
    stage: s,
    leads: onBoard.filter(l => l.stage === s.id && !['lost', 'churned', 'occasional'].includes(l.status))
      .sort((a, b) => sortKey(a, today) - sortKey(b, today)),
  }));
  const lostLeads = onBoard.filter(l => l.status === 'lost' || l.status === 'churned').sort((a, b) => (a.lostAt < b.lostAt ? 1 : -1));
  const occasional = leads.filter(l => l.status === 'occasional')
    .sort((a, b) => occRank(a) - occRank(b) || (a.updatedAt < b.updatedAt ? 1 : -1));
  return {
    html: cols.map(c => column(c, today)).join('') + futureColumn(parked)
      + (occasional.length ? occasionalColumn(occasional) : '')
      + (ui.showLost ? lostColumn(lostLeads) : ''),
    lostCount: lostLeads.length,
    activeCount: leads.filter(l => l.status === 'active').length,
  };
}

export const render = (root, state) => board(root, state, 'warm');
export const renderCold = (root, state) => board(root, state, 'cold');

function board(root, state, cohort) {
  // A search left over from the other board would make this one look empty.
  if (ui.cohort !== cohort) { ui.cohort = cohort; ui.q = ''; }
  const today = new Date();
  const b = boardHtml(state, today);

  root.innerHTML = `
    <div class="toolbar">
      <input class="input input--sm input--search" type="search" placeholder="חיפוש לפי שם או טלפון" value="${esc(ui.q)}" data-q aria-label="חיפוש">
      <label class="switch"><input type="checkbox" data-showlost ${ui.showLost ? 'checked' : ''}><span>הצג אבודים והפסיקו (<span data-lost-count>${fmtNum(b.lostCount)}</span>)</span></label>
      <span class="toolbar__note muted"><span data-active-count>${fmtNum(b.activeCount)}</span> בטיפול · ${esc(COHORTS[cohort].note(b.activeCount))}</span>
      ${cohort === 'warm' ? `<label class="btn btn--sm toolbar__import" title="הוספת רשימת אנשי קשר למזמינים מדי פעם">
        ⤒ ייבוא למזמינים מדי פעם<input type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt" hidden data-import-occ>
      </label>` : ''}
    </div>
    <div class="board ${ui.showLost ? 'board--with-lost' : ''}">${b.html}</div>`;

  root.querySelector('[data-import-occ]')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { openOccasionalImport(await readFile(file)); }
    catch (err) { toast(err.message === 'old_xls' ? 'הקובץ בפורמט ישן (.xls). שמור כ-.xlsx ונסה שוב' : `לא הצלחתי לקרוא את הקובץ: ${err.message}`, 'warn'); }
  });
  root.querySelector('[data-q]').addEventListener('input', e => {
    ui.q = e.target.value;
    const boardEl = root.querySelector('.board');
    const scroll = boardEl.scrollLeft;
    const nb = boardHtml(state, new Date());
    boardEl.innerHTML = nb.html;
    boardEl.scrollLeft = scroll;
    root.querySelector('[data-lost-count]').textContent = fmtNum(nb.lostCount);
    root.querySelector('[data-active-count]').textContent = fmtNum(nb.activeCount);
  });
  root.querySelector('[data-showlost]').addEventListener('change', e => {
    ui.showLost = e.target.checked; sessionStorage.setItem('ribak:showLost', ui.showLost ? '1' : '0'); board(root, state, cohort);
  });
  root.onclick = e => {
    if (e.target.closest('a')) { e.stopPropagation(); return; }
    const mv = e.target.closest('[data-move-menu]');
    if (mv) { e.stopPropagation(); openStageMenu(mv.dataset.moveMenu, mv); return; }
    if (e.target.closest('[data-round]')) { e.stopPropagation(); openRound(store.getState().leads); return; }
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
  if (dueLater(lead)) store.setNextAt(id, null);
  if (lead.stage !== stage) store.moveToStage(id, stage);
  toast(`${lead.name} → ${STAGE_BY_ID[stage].label}`);
}

// Picking the stage from a list beats dragging a card to a column that is
// usually off-screen — same result, one tap, and it works the same on a
// phone.
export function openStageMenu(id, anchor) {
  const lead = store.getLead(id);
  if (!lead) return;
  const parked = dueLater(lead);
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
  const tomorrow = isoDay(addDays(new Date(), 1));
  const m = openModal({
    title: 'פולואפ עתידי',
    body: `
      <form class="form" id="park-form">
        <p class="modal__text">מתי לחזור אל ${esc(lead.name)}? עד אז הוא ימתין בצד ולא יופיע בלוח.</p>
        ${field('תאריך', `<input class="input" type="date" name="nextAt" required value="${esc(tomorrow)}" min="${esc(tomorrow)}">`, 'ביום עצמו הוא יחזור לעמודה שלו')}
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
  const last = lastAction(l);
  return Boolean(last) && daysBetween(last.t, today) === 0;
}

function sortKey(l, today) {
  const acted = lastAction(l);
  if (acted && daysBetween(acted.t, today) === 0) {
    // among those, the one touched longest ago comes first
    return 10000 - (Date.now() - new Date(acted.t)) / 3.6e6;
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

// A lead from a collaboration is only interesting as whose lead it is, so
// the card shows the influencer instead of the bucket the numbers use.
const sourceLabel = l => l.influencer || l.source;

// Which Sunday's delivery this card belongs to — the thing that decides
// which week you are selling them a subscription for.
// A lead that came from an ad says so, and says which one — the creative
// is the part worth knowing, not that it was paid.
function adTag(l) {
  if (!l.adId) return '';
  const ad = store.getAds()[l.adId];
  const label = adLabel(ad);
  return `<span class="tag tag--paid" title="${ad && ad.campaign ? esc(ad.campaign) : 'ליד ממומן'}">
    💰 ${label ? esc(label) : 'ממומן'}</span>`;
}

function weekTag(l) {
  const w = deliveryWeek(l);
  if (!w) return '';
  const waiting = stageIndex(l.stage) === stageIndex('trial');
  return `<span class="tag tag--week" title="${waiting ? 'מקבל את האוכל ביום ראשון הזה' : 'קיבל את האוכל ביום ראשון הזה'}">
    ${waiting ? 'משלוח' : 'אכל'} ${esc(fmtDate(w))}</span>`;
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
      <span class="card__source">${esc(sourceLabel(l))}</span>
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
      ${weekTag(l)}
      ${adTag(l)}
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
  const next = leads[0] ? fmtDate(leads[0].nextAt) : '';
  return `<section class="col col--future" data-stage="__future" aria-label="פולואפ עתידי">
    <header class="col__head">
      <span class="col__dot"></span>
      <h2 class="col__title">פולואפ עתידי</h2>
      <span class="col__count">${fmtNum(leads.length)}</span>
      <span class="col__waiting">${next ? `הקרוב ${esc(next)}` : ''}</span>
    </header>
    <div class="col__body">
      ${leads.length ? leads.map(futureCard).join('')
        : '<div class="col__empty">מי שתסמן לחזור אליו ביום אחר יופיע כאן, ויחזור לעמודה שלו ביום עצמו</div>'}
    </div>
  </section>`;
}

function futureCard(l) {
  const days = daysBetween(new Date(), l.nextAt);
  return `<article class="card card--future" data-id="${l.id}" tabindex="0" style="--c:var(--f${stageIndex(l.stage)})">
    <div class="card__top">
      <b class="card__name">${esc(l.name)}</b>
      <span class="card__source">${esc(sourceLabel(l))}</span>
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


// Customers who buy now and then. They are off the stage columns on
// purpose — they are not work waiting to be done — but they are customers,
// so they stay in sight at the end of the board rather than behind a
// toggle with the losses.
const upcomingOrder = l => { const o = lastOrder(l); return o && o.week && o.week >= sundayOf(new Date()) ? o : null; };
const recentNudge = l => {
  const n = lastNudge(l);
  return n && Date.now() - new Date(n.t).getTime() <= ROUND_GAP_DAYS * 86400000 ? n : null;
};
const awaitingReply = l => (recentNudge(l) && !roundAnswer(l) ? recentNudge(l) : null);
const saidNotNow = l => { const a = recentNudge(l) && roundAnswer(l); return a && a.type === 'declined' ? a : null; };
const occRank = l => (l.noMarketing ? 3 : upcomingOrder(l) ? 0 : awaitingReply(l) ? 1 : 2);

function occasionalColumn(leads) {
  return `<section class="col col--occasional" data-stage="__occasional" aria-label="מזמינים מדי פעם">
    <header class="col__head">
      <span class="col__dot"></span>
      <h2 class="col__title">מזמינים מדי פעם</h2>
      <span class="col__count">${fmtNum(leads.length)}</span>
      <button class="btn btn--sm btn--primary col__round" data-round>📣 סבב הודעות</button>
    </header>
    <div class="col__body">
      ${leads.map(l => {
    const order = upcomingOrder(l), waiting = awaitingReply(l);
    return `<article class="card card--occasional ${l.noMarketing ? 'is-off' : ''}" data-id="${l.id}" tabindex="0">
        <div class="card__top">
          <b class="card__name">${esc(l.name)}</b>
          <span class="card__source">${esc(sourceLabel(l))}</span>
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
          ${order ? `<span class="tag tag--done">✓ הזמין ל-${esc(fmtDate(order.week))}</span>` : ''}
          ${!order && waiting ? `<span class="tag tag--warn">נשלח ${esc(fmtDate(waiting.t))} · עוד לא ענה</span>` : ''}
          ${!order && saidNotNow(l) ? '<span class="tag">ענה: לא הפעם</span>' : ''}
          ${l.noMarketing ? '<span class="tag">הוסר מהודעות</span>' : ''}
        </div>
        <div class="card__actions">
          ${l.noMarketing
      ? `<button class="btn btn--sm btn--ghost" data-act="optin" data-id="${l.id}">החזר להודעות</button>`
      : `${order ? '' : `<button class="btn btn--sm btn--primary" data-act="ordered" data-id="${l.id}">✓ הזמין</button>`}
             <button class="btn btn--sm btn--ghost btn--lost" data-act="optout" data-id="${l.id}" title="לא לשלוח לו יותר הודעות">הסר</button>`}
        </div>
      </article>`;
  }).join('')}
    </div>
  </section>`;
}

// ---- a round of messages ------------------------------------------------
// The whole mechanism is this one dialog: it picks the people who have
// waited longest, hands their numbers to the sender as a file, and marks
// them as written to. Nobody is picked twice inside two weeks, so pressing
// it weekly with fifty at a time walks the list by itself. Replies are
// marked on the card; whoever is not marked simply did not answer.
const ROUND_MSG_KEY = 'ribak:roundMsg2';
const DEFAULT_ROUND_MSG = `היי {שם}, ניב מריבק 👋
השבוע בתפריט: [2–3 מנות].
רוצה משלוח ליום ראשון? לחיצה אחת כאן:
{קישור}
(באותו קישור אפשר גם לבקש שלא אכתוב יותר)`;

function lastRoundLine(leads) {
  const days = leads.map(l => lastNudge(l)).filter(Boolean).map(n => isoDay(n.t)).sort();
  const day = days[days.length - 1];
  if (!day) return '';
  const sent = leads.filter(l => (l.events || []).some(e => e.type === 'nudged' && isoDay(e.t) === day));
  const after = l => (l.events || []).find(e => e.type === 'nudged' && isoDay(e.t) === day).t;
  const got = type => sent.filter(l => (l.events || []).some(e => e.type === type && e.t > after(l))).length;
  const ordered = got('ordered'), declined = got('declined');
  const off = sent.filter(l => l.noMarketing).length;
  const silent = Math.max(0, sent.length - ordered - declined - off);
  return `הסבב האחרון (${fmtDate(day)}): נשלחו ${fmtNum(sent.length)} · הזמינו ${fmtNum(ordered)} · לא הפעם ${fmtNum(declined)} · הסירו ${fmtNum(off)} · לא ענו ${fmtNum(silent)}`;
}

function openRound(leads) {
  const pool = leads.filter(inRounds);
  // People who have actually eaten here first, then whoever has waited longest.
  const due = pool.filter(l => dueForRound(l)).sort((a, b) =>
    (a.contactOnly ? 1 : 0) - (b.contactOnly ? 1 : 0)
    || (lastNudge(a)?.t || '') .localeCompare(lastNudge(b)?.t || ''));
  const recent = pool.length - due.length;
  let msg = DEFAULT_ROUND_MSG;
  try { msg = localStorage.getItem(ROUND_MSG_KEY) || msg; } catch { /* private window */ }
  const stat = lastRoundLine(leads);

  const m = openModal({
    title: 'סבב הודעות',
    body: `
      ${stat ? `<p class="modal__text"><b>${esc(stat)}</b></p>` : ''}
      <p class="modal__text"><b>${fmtNum(due.length)}</b> מחכים להודעה.
        ${recent ? `<span class="muted">${fmtNum(recent)} קיבלו בשבועיים האחרונים או כבר הזמינו, ולא ייכללו.</span>` : ''}</p>
      <form class="form" id="round-form">
        ${field('לכמה לשלוח עכשיו', `<input class="input" type="number" name="n" min="1" max="${due.length}" value="${Math.min(50, due.length)}">`,
    'עד 50 בפעם אחת שומר על המספר שלך בוואטסאפ ועל כמות התשובות שתצטרך לטפל בהן')}
        ${field('ההודעה (להעתקה ל-JONI)', `<textarea class="input" name="msg" rows="6">${esc(msg)}</textarea>`,
    'ב-JONI החלף את {שם} ואת {קישור} בשדות "שם" ו"קישור" מהקובץ. הקישור אישי לכל אחד – הלחיצה שלו נרשמת כאן לבד.')}
      </form>`,
    footer: `<button class="btn" data-close>ביטול</button>
      <button class="btn" data-copy-msg>העתקת ההודעה</button>
      <button class="btn btn--primary" type="submit" form="round-form" ${due.length ? '' : 'disabled'}>הורדת הקובץ וסימון כנשלח</button>`,
  });
  const form = m.el.querySelector('#round-form');
  const remember = () => { try { localStorage.setItem(ROUND_MSG_KEY, form.msg.value); } catch { /* ignore */ } };
  m.el.querySelector('[data-copy-msg]').addEventListener('click', () => {
    remember();
    toast(copyToClipboard(form.msg.value) ? 'ההודעה הועתקה' : 'ההעתקה נכשלה – סמן והעתק ידנית', 'good');
  });
  form.addEventListener('submit', e => {
    e.preventDefault();
    remember();
    const n = Math.max(1, Math.min(due.length, Number(form.n.value) || 0));
    // Marked first: that is what gives each person the token their link is
    // built from.
    const batch = store.nudgeMany(due.slice(0, n).map(l => l.id));
    downloadXlsx(`ribak-round-${isoDay(new Date())}.xlsx`, [
      ['מספר נייד', 'שם', 'שם מלא', 'קישור'],
      ...batch.map(l => [`972${normPhone(l.phone).slice(1)}`, firstName(l.name), l.name, `${location.origin}/r/${l.roundToken}`]),
    ], 'JONI');
    m.close();
    toast(`${fmtNum(batch.length)} בקובץ וסומנו כנשלח. התשובות יירשמו כאן לבד`, 'good');
  });
}

// ---- bringing a contact list in as occasional customers -----------------
// A list of numbers says nothing about who is already a customer here, and
// marking a subscriber "occasional" would quietly break their record. So the
// list is checked against the system first and shown, and only what is new
// is added — nobody who is already here is touched.
const LOOKS_LIKE_CUSTOMER = /לקוח|שבוע ניסיון|מנוי|ניסיון/;

function openOccasionalImport({ leads, skipped }) {
  const fresh = [], known = [];
  for (const r of leads) {
    const have = store.findByPhone(r.phone);
    if (have) known.push({ r, have }); else fresh.push(r);
  }
  if (!fresh.length) {
    toast(known.length ? `כל ${fmtNum(known.length)} האנשים כבר במערכת` : 'לא מצאתי מספרי טלפון בקובץ', 'warn');
    return;
  }
  // The contact's own label — "...לקוח", "...שבוע ניסיון" — often says they
  // are already buying, which a name in a phone book does not make official.
  const flagged = fresh.filter(r => LOOKS_LIKE_CUSTOMER.test(r.name));
  const plain = fresh.filter(r => !LOOKS_LIKE_CUSTOMER.test(r.name));
  const stateOf = l => l.status === 'won' ? 'מנוי פעיל'
    : l.status === 'occasional' ? 'כבר מזמין מדי פעם'
      : l.status === 'lost' || l.status === 'churned' ? 'אבוד' : (STAGE_BY_ID[l.stage]?.short || '');

  const m = openModal({
    title: 'ייבוא למזמינים מדי פעם',
    wide: true,
    body: `
      <p class="modal__text"><b>${fmtNum(plain.length)}</b> אנשים חדשים יתווספו ל"מזמינים מדי פעם".
        ${known.length ? `<br><b>${fmtNum(known.length)}</b> כבר במערכת ולא ייגעו.` : ''}
        ${skipped ? `<br>${fmtNum(skipped)} שורות בלי מספר ישראלי תקין דולגו.` : ''}</p>
      <p class="muted" style="margin-top:0">הם נשמרים כאנשי קשר: לא נספרים כלידים שנכנסו ולא משנים שום אחוז המרה.</p>

      ${flagged.length ? `<details open class="more"><summary>נראים כמו לקוחות קיימים – לא יתווספו אלא אם תסמן (${fmtNum(flagged.length)})</summary>
        <div class="pull-list">${flagged.map((r, i) => `<label class="pull">
          <input type="checkbox" data-flag="${i}"><span class="pull__body"><b>${esc(r.name)}</b>
          <small class="muted">${esc(fmtPhone(r.phone))}</small></span></label>`).join('')}</div></details>` : ''}

      ${known.length ? `<details class="more"><summary>כבר במערכת (${fmtNum(known.length)})</summary>
        <div class="pull-list">${known.map(({ r, have }) => `<div class="pull"><span class="pull__body">
          <b>${esc(have.name)}</b> <small class="muted">${esc(stateOf(have))}${r.name && r.name !== have.name ? ` · ברשימה: ${esc(r.name)}` : ''}</small></span></div>`).join('')}</div></details>` : ''}

      <details class="more"><summary>מי יתווסף (${fmtNum(plain.length)})</summary>
        <div class="pull-list">${plain.map(r => `<div class="pull"><span class="pull__body">
          <b>${esc(r.name || '—')}</b> <small class="muted">${esc(fmtPhone(r.phone))}</small></span></div>`).join('')}</div></details>`,
    footer: `<button class="btn" data-close>ביטול</button><button class="btn btn--primary" data-go>הוספה (${fmtNum(plain.length)})</button>`,
  });

  const go = m.el.querySelector('[data-go]');
  const recount = () => {
    const extra = m.el.querySelectorAll('[data-flag]:checked').length;
    go.textContent = `הוספה (${fmtNum(plain.length + extra)})`;
  };
  m.el.addEventListener('change', e => { if (e.target.matches('[data-flag]')) recount(); });
  go.addEventListener('click', () => {
    const extra = [...m.el.querySelectorAll('[data-flag]:checked')].map(c => flagged[Number(c.dataset.flag)]);
    const n = store.importOccasionalMany([...plain, ...extra]);
    m.close();
    toast(n ? `${fmtNum(n)} נוספו למזמינים מדי פעם` : 'לא נוסף אף אחד', n ? 'good' : 'warn');
  });
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
          <span class="card__source">${esc(sourceLabel(l))}</span>
          <button class="card__move" data-move-menu="${l.id}" title="העברה לשלב אחר" aria-label="העברה לשלב אחר">⇄</button>
        </div>
        <div class="card__row"><span class="tag tag--${l.status === 'churned' ? 'churn' : 'lost'}">${l.status === 'churned' ? 'הפסיק מנוי · ' : ''}${esc(reasonLabel(l.lostReason))}</span></div>
        <div class="card__row muted">בשלב ${esc(STAGE_BY_ID[l.stage].short)} · ${relDays(l.lostAt)}</div>
        <div class="card__actions">${actionButtons(l)}</div>
      </article>`).join('') : `<div class="col__empty">אין לידים אבודים</div>`}
    </div>
  </section>`;
}
