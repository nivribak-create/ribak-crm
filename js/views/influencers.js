// Influencer partnerships — who we want to work with, who we already
// approached, and which collaboration actually produced subscribers.
// Leads tagged with an influencer's handle feed each card's numbers, so a
// collaboration is judged by customers rather than by reach.

import { INFLUENCER_STATUSES, INFLUENCER_STATUS_BY_ID, INFLUENCER_SOURCE, everSubscribed, stageIndex, COLLAB_RE, looksLikeCollab, handleFrom, reasonLabel, DISQUALIFYING } from '../model.js';
import * as store from '../store.js';
import { openModal, confirmDialog, toast, field, formData, copyBtn, copyToClipboard } from '../ui.js';
import { esc, fmtNum, pct1, fmtPhone, telLink, waLink, normPhone, fmtDateLong } from '../util.js';

// Someone already moved across may have been given a different handle, so
// the phone number is what reliably says "this one is already handled".
function alreadyThere(list) {
  const handles = new Set(list.map(i => i.handle.toLowerCase()));
  const phones = new Set(list.map(i => normPhone(i.phone)).filter(Boolean));
  return l => handles.has(handleFrom(l.name)) || phones.has(normPhone(l.phone));
}

export function render(root, state) {
  const list = store.getInfluencers();
  const seen = alreadyThere(list);
  const pending = state.leads.filter(l => looksLikeCollab(l) && !seen(l)).length;
  const stats = statsByHandle(state.leads);
  const cols = INFLUENCER_STATUSES.map(s => ({ status: s, items: list.filter(i => i.status === s.id) }));
  const strays = untracked(state.leads, list);
  const totals = list.reduce((acc, i) => {
    const s = statsFor(stats, i);
    if (s) { acc.leads += s.total; acc.won += s.won; }
    return acc;
  }, { leads: 0, won: 0 });

  root.innerHTML = `
    <div class="toolbar">
      <button class="btn btn--primary" data-add>+ משפיען</button>
      <button class="btn" data-pull>⤴ משוך מהלידים${pending ? ` (${fmtNum(pending)})` : ''}</button>
      <span class="toolbar__note muted">
        ${fmtNum(list.length)} ברשימה${totals.leads ? ` · הביאו ${fmtNum(totals.leads)} לידים ו-${fmtNum(totals.won)} מנויים` : ''}
      </span>
    </div>

    ${strays.length ? `
      <div class="strays">
        <b>הגיעו לידים ממשפיענים שלא ברשימה.</b>
        <span class="muted">הוסף אותם כדי לראות כמה כל אחד הביא ולשלוח להם דוח.</span>
        <div class="strays__row">
          ${strays.map(([h, n]) => `<button class="btn btn--sm" data-add-handle="${esc(h)}">+ @${esc(h)} · ${fmtNum(n)}</button>`).join('')}
        </div>
      </div>` : ''}

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
  root.querySelector('[data-pull]')?.addEventListener('click', () => openPull(state));
  root.querySelectorAll('[data-add-handle]').forEach(b =>
    b.addEventListener('click', () => openClaim(b.dataset.addHandle, store.getInfluencers())));
  root.onclick = e => {
    if (e.target.closest('a')) { e.stopPropagation(); return; }
    const move = e.target.closest('[data-move]');
    if (move) {
      e.stopPropagation();
      store.setInfluencerStatus(move.dataset.id, move.dataset.move);
      return;
    }
    const rep = e.target.closest('[data-report]');
    if (rep) {
      e.stopPropagation();
      const inf = store.getInfluencers().find(i => i.id === rep.dataset.report);
      if (inf) openReport(inf, state.leads);
      return;
    }
    const card = e.target.closest('.icard');
    if (card) openForm(store.getInfluencers().find(i => i.id === card.dataset.id));
  };
}

const key = h => String(h || '').trim().replace(/^@/, '').toLowerCase();
// An influencer answers both to their handle and to the shorter id their
// gateway link puts on a lead.
const keysOf = i => [key(i.handle), key(i.ref)].filter(Boolean);
const ownerOf = (list, handle) => { const k = key(handle); return list.find(i => keysOf(i).includes(k)) || null; };

// Leads carry the influencer handle as free text, so match case-insensitively
// and ignore a leading @ either side.
// Leads come in tagged with the handle from the link they clicked, and that
// person may not be on this board at all — without this their leads are
// counted nowhere and nobody can send them a report.
function untracked(leads, list) {
  const known = new Set(list.flatMap(keysOf));
  const found = new Map();
  for (const l of leads) {
    const k = key(l.influencer);
    if (!k || known.has(k)) continue;
    found.set(k, (found.get(k) || 0) + 1);
  }
  return [...found].sort((a, b) => b[1] - a[1]);
}

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
      ${items.length ? items.map(i => card(i, statsFor(stats, i))).join('') : '<div class="col__empty">ריק</div>'}
    </div>
  </section>`;
}

const statsFor = (stats, inf) => {
  const parts = keysOf(inf).map(k => stats[k]).filter(Boolean);
  if (!parts.length) return undefined;
  return parts.reduce((a, b) => ({ total: a.total + b.total, trial: a.trial + b.trial, won: a.won + b.won }));
};

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
    ${inf.phone ? `<div class="card__meta">
      <span class="card__phone-wrap">
        <a class="card__phone" href="${telLink(inf.phone)}">${esc(fmtPhone(inf.phone))}</a>
        ${copyBtn(inf.phone)}
      </span>
      <a class="card__wa" href="${waLink(inf.phone)}" target="_blank" rel="noopener">וואטסאפ</a>
    </div>` : ''}
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
      ${s ? `<button class="btn btn--sm" data-report="${inf.id}">✉ דוח למשפיען</button>` : ''}
      ${inf.status !== 'rejected' ? `<button class="btn btn--sm btn--ghost btn--lost" data-move="rejected" data-id="${inf.id}">לא יצא</button>` : ''}
    </div>
  </article>`;
}

function openForm(inf = null) {
  const isEdit = Boolean(inf);
  const body = `
    <form class="form" id="infl-form">
      ${field('שם משתמש באינסטגרם', `<input class="input" name="handle" required value="${esc(inf?.handle || '')}" placeholder="noa_fit" autocomplete="off" dir="ltr">`, 'בלי @ – זה מה שמקשר בין המשפיען ללידים שהוא מביא')}
      ${field('מזהה בלינק', `<input class="input" name="ref" value="${esc(inf?.ref || '')}" placeholder="noa" autocomplete="off" dir="ltr">`, 'ה-ref שמופיע בלינק הייעודי שלו, אם הוא שונה משם המשתמש')}
      ${field('שם', `<input class="input" name="name" value="${esc(inf?.name || '')}" placeholder="נועה כהן" autocomplete="off">`)}
      ${field('טלפון', `<input class="input" name="phone" inputmode="tel" value="${esc(inf?.phone || '')}" placeholder="050-0000000" autocomplete="off">`)}
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




// A link id that nobody on the board answers to is either a new partner or
// the short form of someone already here, and only the person who set up
// the link knows which — so it is asked rather than guessed.
function openClaim(handle, list) {
  const options = list
    .slice()
    .sort((a, b) => a.handle.localeCompare(b.handle))
    .map(i => `<option value="${esc(i.id)}">@${esc(i.handle)}${i.name ? ` – ${esc(i.name)}` : ''}</option>`)
    .join('');
  const m = openModal({
    title: `לידים מ-@${handle}`,
    body: `
      <p class="modal__text">הגיעו לידים עם המזהה <b dir="ltr">${esc(handle)}</b>. למי הם שייכים?</p>
      <form class="form" id="claim-form">
        ${field('', `<label class="radio"><input type="radio" name="who" value="new" checked> <span>משפיען חדש – פתח לו כרטיס בשם <b dir="ltr">@${esc(handle)}</b></span></label>
        ${options ? `<label class="radio"><input type="radio" name="who" value="old"> <span>מישהו שכבר ברשימה:</span></label>
        <select class="input" name="id" ${list.length ? '' : 'disabled'}>${options}</select>` : ''}`)}
      </form>`,
    footer: `<button class="btn" data-close>ביטול</button><button class="btn btn--primary" type="submit" form="claim-form">שיוך</button>`,
  });
  m.el.querySelector('#claim-form').addEventListener('submit', e => {
    e.preventDefault();
    const d = formData(e.target);
    if (d.who === 'old' && d.id) {
      const inf = store.getInfluencers().find(i => i.id === d.id);
      if (!inf) return;
      store.saveInfluencer({ ...inf, ref: handle });
      toast(`הלידים של ${handle} שויכו ל-@${inf.handle}`, 'good');
    } else {
      store.saveInfluencer({ handle, status: 'active' });
      toast(`@${handle} נוסף לרשימה`, 'good');
    }
    m.close();
  });
}

// ---- the message you send an influencer ---------------------------------
// What a collaboration is owed is an honest account of what their link
// brought in: how many, which ones were not real, and in whose words.
const hhmm = t => String(t).slice(11, 16);
const whenRange = ls => {
  const days = [...new Set(ls.map(l => String(l.createdAt).slice(0, 10)))];
  const first = ls[0], last = ls[ls.length - 1];
  return days.length === 1
    ? `${fmtDateLong(first.createdAt)}, ${hhmm(first.createdAt)}–${hhmm(last.createdAt)}`
    : `${fmtDateLong(first.createdAt)} – ${fmtDateLong(last.createdAt)}`;
};
const count = (n, one, many) => (n === 1 ? one : `${fmtNum(n)} ${many}`);

export function buildReport(inf, leads) {
  const keys = keysOf(inf);
  const mine = leads
    .filter(l => keys.includes(key(l.influencer)))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  if (!mine.length) return `היי @${inf.handle} – עוד לא הגיעו לידים דרך הלינק.`;

  // "Not relevant" means it was never an opportunity — a wrong number, a
  // duplicate, outside the delivery area. Someone who heard the pitch and
  // said the price was too high was a real lead, and saying otherwise would
  // blame the influencer for a sale we did not make.
  const out = mine.filter(l => l.status === 'lost' && DISQUALIFYING.has(l.lostReason));
  const good = mine.length - out.length;
  const trial = mine.filter(l => stageIndex(l.stage) >= stageIndex('trial')).length;
  const won = mine.filter(everSubscribed).length;
  const working = mine.filter(l => l.status === 'active').length;

  const lines = [`היי @${inf.handle} 🙏`, ''];
  lines.push(`עברתי על הלידים שהגיעו דרך הלינק שלך – ${count(mine.length, 'ליד אחד', 'לידים')}, ${whenRange(mine)}.`);
  lines.push('');

  if (!out.length) {
    lines.push('כולם רלוונטיים, אין אחד לפסול 🙌');
  } else {
    lines.push(`${count(out.length, 'אחד לא רלוונטי', 'לא רלוונטיים')}:`);
    lines.push('');
    out.forEach((l, i) => {
      const said = (l.events || []).filter(e => e.type === 'lost' && e.text).pop();
      lines.push(`${i + 1}. ${l.name} · ${hhmm(l.createdAt)}`);
      lines.push(`   ${reasonLabel(l.lostReason)}${said ? ` – ${said.text}` : ''}`);
    });
    lines.push('');
    lines.push(`${fmtNum(good)} מתוך ${fmtNum(mine.length)} לידים אמיתיים (${pct1(good, mine.length)}%).`);
  }

  lines.push('');
  const progress = [];
  if (won) progress.push(`${count(won, 'אחד סגר מנוי', 'סגרו מנוי')}`);
  if (trial) progress.push(`${count(trial, 'אחד סגר שבוע ניסיון', 'סגרו שבוע ניסיון')}`);
  if (working) progress.push(`${count(working, 'אחד עדיין בטיפול אצלי', 'עדיין בטיפול אצלי')}`);
  if (progress.length) lines.push(progress.join(', ') + '.');
  lines.push('');
  lines.push('תודה!');
  return lines.join('\n');
}

function openReport(inf, leads) {
  const text = buildReport(inf, leads);
  const m = openModal({
    title: `דוח ל-@${inf.handle}`,
    body: `
      <p class="muted" style="margin-top:0">אפשר לערוך לפני ששולחים.</p>
      <textarea class="input" id="infl-report" rows="16" dir="rtl">${esc(text)}</textarea>`,
    footer: `
      <button class="btn" data-close>סגירה</button>
      ${inf.phone ? `<a class="btn" id="infl-wa" href="${waLink(inf.phone)}" target="_blank" rel="noopener">וואטסאפ</a>` : ''}
      <button class="btn btn--primary" data-copy-report>העתקת ההודעה</button>`,
  });
  const ta = m.el.querySelector('#infl-report');
  // WhatsApp takes the message in the link, so it has to follow the edits.
  const wa = m.el.querySelector('#infl-wa');
  if (wa) {
    const base = wa.href.split('?')[0];
    const sync = () => { wa.href = `${base}?text=${encodeURIComponent(ta.value)}`; };
    sync();
    ta.addEventListener('input', sync);
  }
  m.el.querySelector('[data-copy-report]').addEventListener('click', () => {
    if (copyToClipboard(ta.value)) toast('ההודעה הועתקה', 'good');
    else toast('ההעתקה נכשלה – סמן והעתק ידנית', 'warn');
  });
}

// ---- pulling collaborators out of the lead list -------------------------
function openPull(state) {
  const seen = alreadyThere(store.getInfluencers());
  const found = state.leads
    .filter(l => looksLikeCollab(l) && !seen(l))
    .map(l => ({ lead: l, handle: handleFrom(l.name) }))
    .filter(x => x.handle);

  if (!found.length) {
    openModal({
      title: 'משיכה מהלידים',
      body: `<p class="modal__text">לא נמצאו לידים שרשום עליהם שת״פ, שיתוף פעולה או משפיען.<br>
        אם יש כאלה אצלך – ודא שהמילה מופיעה בשם הליד או בהערות שלו, ונסה שוב.</p>`,
      footer: '<button class="btn btn--primary" data-close>סגירה</button>',
    });
    return;
  }

  const body = `
    <p class="modal__text">נמצאו <b>${fmtNum(found.length)}</b> לידים שנראים כמו שיתופי פעולה. בחר את מי להעביר לרשימת המשפיענים.</p>
    <div class="pull-list">
      ${found.map((x, i) => `
        <label class="pull">
          <input type="checkbox" checked data-i="${i}">
          <span class="pull__body">
            <b>${esc(x.lead.name)}</b>
            <small class="muted">${esc(fmtPhone(x.lead.phone))}${x.lead.notes ? ' · ' + esc(x.lead.notes) : ''}</small>
            <input class="input input--sm" data-handle="${i}" value="${esc(x.handle)}" dir="ltr" placeholder="שם משתמש באינסטגרם" aria-label="שם משתמש">
          </span>
        </label>`).join('')}
    </div>
    <label class="switch pull__opt"><input type="checkbox" data-remove checked><span>גם להוציא אותם מהפייפליין (יסומנו כ"לא רלוונטי", אפשר להחזיר)</span></label>
    <p class="field__hint">שם המשתמש הוא מה שמקשר משפיען ללידים שהוא מביא – אפשר לתקן אותו כאן או אחר כך.</p>`;

  const m = openModal({
    title: 'משיכה מהלידים',
    wide: true,
    body,
    footer: `<button class="btn" data-close>ביטול</button><button class="btn btn--primary" data-go>העבר למשפיענים</button>`,
  });

  m.el.querySelector('[data-go]').addEventListener('click', () => {
    const remove = m.el.querySelector('[data-remove]').checked;
    const picked = [...m.el.querySelectorAll('[data-i]')].filter(c => c.checked).map(c => Number(c.dataset.i));
    if (!picked.length) { toast('לא נבחר אף אחד', 'warn'); return; }

    const added = store.saveInfluencers(picked.map(i => ({
      handle: m.el.querySelector(`[data-handle="${i}"]`).value,
      name: found[i].lead.name.replace(COLLAB_RE, '').trim(),
      phone: found[i].lead.phone,
      notes: found[i].lead.notes,
      status: 'wishlist',
    })));

    if (remove) picked.forEach(i => store.markLost(found[i].lead.id, 'irrelevant', 'הועבר לרשימת המשפיענים'));

    m.close();
    toast(added.length
      ? `${fmtNum(added.length)} עברו למשפיענים${remove ? ' והוצאו מהפייפליין' : ''}`
      : 'כולם כבר היו ברשימה', added.length ? 'good' : 'warn');
  });
}
