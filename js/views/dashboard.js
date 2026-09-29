import { STAGE_BY_ID, SOURCES, OUTCOMES } from '../model.js';
import { computeAnalytics, RANGES } from '../analytics.js';
import { hbars, meter } from '../charts.js';
import { esc, fmtNum, pct1, plural, dueLabel, daysBetween, fmtPhone, waLink, telLink, deadlineLabel, fmtDateTime, fmtDateLong } from '../util.js';
import { handleAction, openDrawer } from '../lead.js';
import { copyBtn } from '../ui.js';

const ui = {
  range: sessionStorage.getItem('ribak:range') || '90',
  source: sessionStorage.getItem('ribak:source') || '',
};

export function render(root, state) {
  const a = computeAnalytics(state.leads, ui);
  const hasAny = state.leads.length > 0;

  root.innerHTML = `
    ${!hasAny ? emptyState() : ''}

    ${hasAny ? dayCard(a) : ''}
    ${hasAny ? conversionCard(a) : ''}
    ${hasAny ? thisWeek(a) : ''}

    <section class="panel">
      <header class="panel__head"><div><h2>לחזור אליהם היום</h2><p class="muted">לידים בטיפול עם פעולה מתוכננת להיום או באיחור</p></div></header>
      ${dueList(state.leads)}
    </section>

    ${hasAny ? `
    <details class="more-data">
      <summary>עוד נתונים</summary>
      <div class="toolbar">
        <div class="chips" role="tablist" aria-label="טווח זמן">
          ${RANGES.map(r => `<button class="chip ${ui.range === r.id ? 'is-on' : ''}" data-range="${r.id}" role="tab" aria-selected="${ui.range === r.id}">${r.label}</button>`).join('')}
        </div>
        <select class="input input--sm" data-source aria-label="מקור">
          <option value="">כל המקורות</option>
          ${SOURCES.map(s => `<option value="${esc(s)}" ${ui.source === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
        <span class="toolbar__note muted">לפי תאריך כניסת הליד</span>
      </div>

      <section class="panel">
        <header class="panel__head"><div><h2>מה יצא מהלידים</h2></div></header>
        ${outcomeBars(a)}
      </section>

      <div class="grid-2">
        <section class="panel">
          <header class="panel__head"><div><h2>למה לידים נופלים</h2></div></header>
          ${hbars(a.reasons.map(r => ({
            label: r.label, value: r.count, share: r.share, topStage: r.topStage,
          })), { color: 'lost', valueLabel: (v, it) => `${fmtNum(v)} <small>${it.share}%</small>`, sub: it => it.topStage ? `בעיקר בשלב ${esc(STAGE_BY_ID[it.topStage]?.short || '')}` : '' })}
        </section>
        <section class="panel">
          <header class="panel__head"><div><h2>לפי מקור</h2></div></header>
          ${sourcesTable(a)}
        </section>
      </div>

      ${a.influencers.length ? `
      <section class="panel">
        <header class="panel__head"><div><h2>לפי משפיען</h2></div></header>
        ${influencerTable(a)}
      </section>` : ''}
    </details>` : ''}`;

  root.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => {
    ui.range = b.dataset.range; sessionStorage.setItem('ribak:range', ui.range); render(root, state);
  }));
  root.querySelector('[data-source]')?.addEventListener('change', e => {
    ui.source = e.target.value; sessionStorage.setItem('ribak:source', ui.source); render(root, state);
  });
  root.onclick = e => {
    if (handleAction(e)) return;
    const oc = e.target.closest('[data-outcome]');
    if (oc) { sessionStorage.setItem('ribak:outcome', oc.dataset.outcome); return; }
    const row = e.target.closest('[data-open]');
    if (row) openDrawer(row.dataset.open);
  };
}

function rangeNote() {
  const r = RANGES.find(x => x.id === ui.range);
  return r?.days ? `ב-${r.days} הימים האחרונים` : 'מאז ומתמיד';
}


const OUTCOME_CLASS = { open: 'active', subscriber: 'won', churned: 'churn', repeat_only: 'warn', trial_only: 'lost', never_paid: 'lost' };

// The day, counted off the timeline: every dial, every conversation that
// actually happened, and everything that closed.
function dayCard(a) {
  const t = a.today;
  const y = a.yesterday;
  const cell = (label, now, then, note = '') => `
    <div class="day__cell">
      <b>${fmtNum(now)}</b>
      <span>${esc(label)}</span>
      <small>${note || `אתמול ${fmtNum(then)}`}</small>
    </div>`;
  const closeNote = t.closes
    ? `${fmtNum(t.trialCloses)} שבוע ניסיון · ${fmtNum(t.subCloses)} מנוי`
    : `אתמול ${fmtNum(y.closes)}`;
  return `<section class="day">
    <header class="day__head">
      <h2>סיכום היום</h2>
      <span class="muted">${esc(fmtDateLong(new Date().toISOString()))}</span>
    </header>
    <div class="day__cells">
      ${cell('חיוגים', t.dials, y.dials)}
      ${cell('שיחות מלאות', t.fullCalls, y.fullCalls)}
      ${cell('סגירות', t.closes, y.closes, closeNote)}
    </div>
  </section>`;
}

// The one conversion the business turns on: a first week becoming a
// standing order. Counted over everyone who actually received the food,
// since a lead still waiting for Sunday has not had the chance yet.
function conversionCard(a) {
  const c = a.sellSub;
  if (!c.from) {
    return `<section class="conv"><h2>המרה ממנו למנוי</h2>
      <p class="conv__body">עוד אף אחד לא קיבל משלוח בטווח הזה.</p></section>`;
  }
  const tone = c.pct >= 50 ? 'good' : c.pct >= 30 ? 'warn' : 'bad';
  return `<section class="conv conv--${tone}">
    <h2>המרה ממנו למנוי</h2>
    <p class="conv__big">${c.pct}%</p>
    <p class="conv__body">
      <b>${fmtNum(c.to)}</b> מתוך <b>${fmtNum(c.from)}</b> שעשו שבוע ניסיון וקיבלו את האוכל סגרו מנוי.
      ${c.lost ? `${fmtNum(c.lost)} לא המשיכו.` : ''}
    </p>
  </section>`;
}

// The week has a shape: food goes out Sunday, orders close Wednesday
// 23:00, and everyone who ate this week has to be converted before then.
function thisWeek(a) {
  const w = a.week;
  const tight = w.toConvert > 0;
  return `<section class="week">
    <header class="week__head">
      <h2>השבוע הזה</h2>
      <span class="week__clock ${tight ? 'is-tight' : ''}">
        הזמנות נסגרות ${esc(fmtDateTime(w.deadline.toISOString()))} · ${esc(deadlineLabel())}
      </span>
    </header>
    <div class="week__cells">
      <a class="wcell ${w.toConvert ? 'is-hot' : ''}" href="#/pipeline">
        <b>${fmtNum(w.toConvert)}</b>
        <span>קיבלו אוכל וממתינים להמרה למנוי</span>
        <small>${w.toConvert ? 'צריך לסגור אותם לפני הדדליין' : 'אין ממתינים'}</small>
      </a>
      <a class="wcell" href="#/pipeline">
        <b>${fmtNum(w.toCall)}</b>
        <span>לידים חדשים שממתינים לשיחת מכירה</span>
        <small>${w.toCall ? 'כל אחד שייסגר עד הדדליין יקבל אוכל ביום ראשון' : 'אין ממתינים'}</small>
      </a>
      <a class="wcell" href="#/pipeline">
        <b>${fmtNum(w.waitingDelivery)}</b>
        <span>שילמו וממתינים למשלוח ביום ראשון</span>
        <small>${w.waitingDelivery ? 'אליהם מתקשרים ביום שלישי' : 'אין ממתינים'}</small>
      </a>
    </div>
  </section>`;
}

function outcomeBars(a) {
  if (!a.total) return `<div class="empty">אין לידים בטווח הזה</div>`;
  const max = Math.max(...a.outcomes.map(o => o.count)) || 1;
  return `<div class="outcomes">${a.outcomes.map(o => `
    <a class="outcome outcome--${OUTCOME_CLASS[o.id]}" href="#/leads" data-outcome="${o.id}">
      <span class="outcome__label">${esc(o.label)}</span>
      <span class="outcome__track"><span class="outcome__fill" style="width:${(o.count / max) * 100}%"></span></span>
      <span class="outcome__value">${fmtNum(o.count)}<small>${pct1(o.count, a.total)}%</small></span>
    </a>`).join('')}</div>`;
}

function influencerTable(a) {
  const max = Math.max(...a.influencers.map(i => i.total)) || 1;
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>משפיען</th><th class="num">לידים</th><th class="num">ניסיון</th><th class="num">מנוי</th><th class="num">המרה</th><th class="w-meter"></th></tr></thead>
    <tbody>${a.influencers.map(i => `<tr>
      <td>${esc(i.name)}</td>
      <td class="num">${fmtNum(i.total)}</td>
      <td class="num">${fmtNum(i.trial)}</td>
      <td class="num">${fmtNum(i.won)}</td>
      <td class="num ${i.won && i.conv >= a.convTotal ? 'good' : ''}">${i.conv}%</td>
      <td class="w-meter">${meter(i.total, max)}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function sourcesTable(a) {
  if (!a.sources.length) return `<div class="empty">אין נתונים</div>`;
  const max = Math.max(...a.sources.map(s => s.total));
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>מקור</th><th class="num">לידים</th><th class="num">ניסיון</th><th class="num">מנוי</th><th class="num">המרה</th><th class="w-meter"></th></tr></thead>
    <tbody>${a.sources.map(s => `<tr>
      <td>${esc(s.source)}</td>
      <td class="num">${fmtNum(s.total)}</td>
      <td class="num">${fmtNum(s.trial)}</td>
      <td class="num">${fmtNum(s.won)}</td>
      <td class="num ${s.conv >= a.convTotal && s.won ? 'good' : ''}">${s.conv}%</td>
      <td class="w-meter">${meter(s.total, max)}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}


function dueList(leads) {
  const today = new Date();
  const due = leads
    .filter(l => l.status === 'active' && l.nextAt && daysBetween(today, l.nextAt) <= 0)
    .sort((a, b) => (a.nextAt < b.nextAt ? -1 : 1));
  if (!due.length) return `<div class="empty">אין פולואפים שממתינים להיום. 👌</div>`;
  return `<ul class="due-list">${due.map(l => {
    const late = daysBetween(today, l.nextAt) < 0;
    return `<li class="due" data-open="${l.id}">
      <div class="due__main">
        <b>${esc(l.name)}</b>
        <span class="muted">${esc(STAGE_BY_ID[l.stage].label)} · ${esc(l.source)}</span>
      </div>
      <span class="tag ${late ? 'tag--lost' : 'tag--warn'}">${dueLabel(l.nextAt)}</span>
      <div class="due__contact">
        <a class="contact contact--tel" href="${telLink(l.phone)}" onclick="event.stopPropagation()">📞</a>
        ${copyBtn(l.phone)}
        <a class="contact contact--wa" href="${waLink(l.phone)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">וואטסאפ</a>
      </div>
    </li>`;
  }).join('')}</ul>`;
}

function emptyState() {
  return `<div class="hero-empty">
    <h2>עדיין אין לידים</h2>
    <p>הוסף ליד ראשון, או טען נתוני דוגמה כדי לראות איך הלוח נראה כשהוא מלא.</p>
    <div class="hero-empty__actions">
      <button class="btn btn--primary" data-global="add">+ ליד חדש</button>
      <button class="btn" data-global="sample">טען נתוני דוגמה</button>
    </div>
  </div>`;
}
