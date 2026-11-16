import { STAGE_BY_ID, SOURCES, OUTCOMES, viaMagnet, deliveryWeek, subscriptionWeek, stageIndex, everSubscribed, adInfo, isPaying, paidTotal, AD_ARMS, AD_VIDEOS } from '../model.js';
import { computeAnalytics, RANGES, dayReport } from '../analytics.js';
import { hbars, meter } from '../charts.js';
import { esc, fmtNum, pct1, plural, dueLabel, daysBetween, fmtPhone, waLink, telLink, deadlineLabel, fmtDateTime, fmtDateLong, fmtDate, isParked, sundayOf } from '../util.js';
import { handleAction, openDrawer } from '../lead.js';
import { openModal, toast, field, formData } from '../ui.js';
import { copyBtn } from '../ui.js';
import * as store from '../store.js';

const ui = {
  range: sessionStorage.getItem('ribak:range') || '90',
  source: sessionStorage.getItem('ribak:source') || '',
};

export function render(root, state) {
  // Cold leads from a magnet have their own screen; counting them here
  // would bury the people who came asking under people who never did.
  const a = computeAnalytics(state.leads, { ...ui, cohort: 'warm' });
  const cold = state.leads.filter(viaMagnet).length;
  const hasAny = state.leads.length > 0;

  root.innerHTML = `
    ${!hasAny ? emptyState() : ''}
    ${cold ? `<p class="cold-note">${fmtNum(cold)} לידים קרים מהמגנט נספרים בנפרד · <a href="#/magnet">למסך המגנט ←</a></p>` : ''}

    ${hasAny ? dayCard(a, cold ? dayReport(state.leads) : null) : ''}
    ${hasAny ? trialCard(a) : ''}
    ${hasAny ? conversionCard(a) : ''}
    ${hasAny ? thisWeek(a) : ''}
    ${hasAny ? deliveryWeeksCard(state.leads) : ''}
    ${hasAny ? abTestPanel(state.leads) : ''}

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

      ${adsPanel(state.leads)}

      ${a.influencers.length ? `
      <section class="panel">
        <header class="panel__head"><div><h2>לפי משפיען</h2></div></header>
        ${influencerTable(a)}
      </section>` : ''}
    </details>` : ''}`;

  root.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => {
    ui.range = b.dataset.range; sessionStorage.setItem('ribak:range', ui.range); render(root, state);
  }));
  root.querySelector('[data-load-ads]')?.addEventListener('click', openAdsLoader);
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


// ---- by ad --------------------------------------------------------------
// A click-to-DM campaign runs a dozen creatives at once and Meta can only
// say which one was clicked. Which one produced a customer is a question
// only this side can answer, so the ad id rides along with the lead and
// gets a name here.
function adsPanel(leads) {
  const names = store.getAds();
  const by = new Map();
  for (const l of leads) {
    const ad = adInfo(l.adId, names);
    // Paused ads were asked to be left out of the picture altogether.
    if (!ad || ad.retired || l.contactOnly) continue;
    const row = by.get(ad.id) || { ad, total: 0, trial: 0, paying: 0, won: 0 };
    row.total++;
    if (stageIndex(l.stage) >= stageIndex('trial')) row.trial++;
    if (isPaying(l)) row.paying++;
    if (everSubscribed(l)) row.won++;
    by.set(ad.id, row);
  }
  if (!by.size) return '';
  const rows = [...by.values()].sort((a, b) => b.total - a.total);
  return `<section class="panel">
    <header class="panel__head"><div><h2>לפי מודעה</h2>
      <p class="muted">איזו מודעה הביאה ליד, ומה יצא ממנו</p></div>
      <button class="btn btn--sm" data-load-ads>טעינת שמות מודעות</button>
    </header>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>מודעה</th><th>זרוע</th><th class="num">לידים</th><th class="num">משלמים</th><th class="num">מנוי</th></tr></thead>
      <tbody>
        ${rows.map(({ ad, total, paying, won }) => `<tr>
          <td>${ad.known ? esc(ad.code ? `${ad.code} · ${ad.videoName}` : ad.label) : `<span class="warn">לא מזוהה</span> <small class="muted" dir="ltr">${esc(ad.id)}</small>`}${ad.campaign ? `<br><small class="muted">${esc(ad.campaign)}</small>` : ''}</td>
          <td><small class="muted">${esc(ad.armLabel || ad.adset || '–')}</small></td>
          <td class="num">${fmtNum(total)}</td>
          <td class="num">${fmtNum(paying)}</td>
          <td class="num"><b>${fmtNum(won)}</b></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </section>`;
}

// ---- landing page against DM ---------------------------------------------
// One video, two ways in. Meta knows what each ad cost; only this side knows
// which leads ended up paying, so the table stops at paying customers and
// the division by spend is done against Meta's numbers.
function abTestPanel(leads) {
  const names = store.getAds();
  const cell = () => ({ leads: 0, paying: 0, revenue: 0 });
  const grid = new Map(AD_VIDEOS.map(v => [v.n, Object.fromEntries(AD_ARMS.map(a => [a.id, cell()]))]));
  const total = Object.fromEntries(AD_ARMS.map(a => [a.id, cell()]));
  const unknown = new Map();
  for (const l of leads) {
    const ad = adInfo(l.adId, names);
    if (!ad || l.contactOnly) continue;
    if (!ad.known) { unknown.set(ad.id, (unknown.get(ad.id) || 0) + 1); continue; }
    if (!ad.code) continue;
    for (const c of [grid.get(ad.video)[ad.arm], total[ad.arm]]) {
      c.leads++;
      if (isPaying(l)) { c.paying++; c.revenue += paidTotal(l); }
    }
  }
  const any = AD_ARMS.some(a => total[a.id].leads);
  if (!any && !unknown.size) return '';
  const pair = c => `<td class="num">${fmtNum(c.leads)}</td><td class="num"><b>${fmtNum(c.paying)}</b>${c.leads ? ` <small class="muted">${pct1(c.paying, c.leads)}%</small>` : ''}</td>`;
  const revenue = AD_ARMS.filter(a => total[a.id].revenue).map(a => `${a.label} ₪${fmtNum(total[a.id].revenue)}`);
  const ids = [...unknown.keys()];
  return `<section class="panel">
    <header class="panel__head"><div><h2>דף נחיתה מול DM</h2>
      <p class="muted">אותם ארבעה סרטונים בשתי דרכים · כמה לידים הביא כל אחד וכמה מהם שילמו</p></div></header>
    ${ids.length ? `<p class="ad-alert"><b>${fmtNum(ids.length)} ${ids.length === 1 ? 'מזהה מודעה לא מזוהה' : 'מזהי מודעות לא מזוהים'}</b>
      (${(n => plural(n, 'ליד אחד', `${fmtNum(n)} לידים`))([...unknown.values()].reduce((a, b) => a + b, 0))}) – צריך לשלוח למי שמנהל את הקמפיין:
      <span dir="ltr">${ids.map(esc).join(', ')}</span> ${copyBtn(ids.join(', '), 'העתקת המזהים')}</p>` : ''}
    ${any ? `<div class="table-wrap"><table class="table table--ab">
      <thead>
        <tr><th rowspan="2">סרטון</th>${AD_ARMS.map(a => `<th colspan="2" class="ab-arm">${esc(a.label)} (${a.letter})</th>`).join('')}</tr>
        <tr>${AD_ARMS.map(() => `<th class="num">לידים</th><th class="num">משלמים</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${AD_VIDEOS.map(v => `<tr><td>${v.n} · ${esc(v.name)}</td>${AD_ARMS.map(a => pair(grid.get(v.n)[a.id])).join('')}</tr>`).join('')}
        <tr class="ab-total"><td>סה"כ</td>${AD_ARMS.map(a => pair(total[a.id])).join('')}</tr>
      </tbody>
    </table></div>
    <p class="panel__note">משלם = סגר שבוע ניסיון, או שנרשם לו תשלום בכרטיס.${revenue.length ? ` הכנסה שנרשמה: ${esc(revenue.join(' · '))}.` : ''}
      את ההוצאה לכל מודעה לוקחים ממטא ומחלקים במספר המשלמים.</p>` : ''}
  </section>`;
}

function openAdsLoader() {
  const current = JSON.stringify(store.getAds(), null, 1);
  const m = openModal({
    title: 'שמות המודעות',
    wide: true,
    body: `
      <p class="modal__text">הדבק כאן את רשימת המודעות ממטא. המערכת שומרת רק את השמות,
        כדי שהטבלה תציג "פרק 7 | מה אוכלים היום" במקום מספר.</p>
      <textarea class="input" id="ads-json" rows="12" dir="ltr" spellcheck="false">${esc(current === '{}' ? '' : current)}</textarea>`,
    footer: `<button class="btn" data-close>ביטול</button><button class="btn btn--primary" data-save-ads>שמירה</button>`,
  });
  m.el.querySelector('[data-save-ads]').addEventListener('click', () => {
    const raw = m.el.querySelector('#ads-json').value.trim();
    if (!raw) { store.saveAds({}); toast('הרשימה נוקתה'); m.close(); return; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { toast('הטקסט אינו JSON תקין', 'warn'); return; }
    const n = store.saveAds(parsed);
    toast(`${n} מודעות נשמרו`, 'good');
    m.close();
  });
}
// ---- by delivery week ---------------------------------------------------
// Food goes out on Sundays, so a customer belongs to the Sunday they were
// fed on, and the subscription you are selling them is for the Sunday after
// that. Lined up this way, each week's batch can be watched to the end
// instead of blurring into a running total.
function deliveryWeeksCard(leads) {
  const by = new Map();
  for (const l of leads) {
    if (stageIndex(l.stage) < stageIndex('delivered')) continue;
    const w = deliveryWeek(l);
    if (!w) continue;
    const row = by.get(w) || { week: w, got: 0, sub: 0, repeat: 0, occasional: 0, lost: 0, open: 0 };
    row.got++;
    if (everSubscribed(l)) row.sub++;
    else if (l.status === 'occasional') row.occasional++;
    else if (l.status === 'lost' || l.status === 'churned') row.lost++;
    else if (l.stage === 'repeat') row.repeat++;
    else row.open++;
    by.set(w, row);
  }
  const rows = [...by.values()].sort((a, b) => (a.week < b.week ? 1 : -1)).slice(0, 8);
  if (!rows.length) return '';
  const thisSunday = sundayOf(new Date());
  return `<section class="panel">
    <header class="panel__head"><div><h2>לפי שבוע משלוח</h2>
      <p class="muted">מי שקיבל אוכל בראשון נמכר לו מנוי לראשון שאחריו</p></div></header>
    <div class="table-wrap"><table class="table">
      <thead><tr>
        <th>משלוח</th><th class="num">קיבלו אוכל</th><th class="num">מנוי</th>
        <th class="num">שבוע נוסף</th><th class="num">מדי פעם</th><th class="num">נפלו</th><th class="num">פתוח</th>
        <th class="num">% מנוי</th><th class="num">% המשיכו</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => `<tr class="${r.week === thisSunday ? 'is-now' : ''}">
          <td>ראשון ${esc(fmtDate(r.week))}${r.week === thisSunday ? ' <small class="muted">· השבוע</small>' : ''}</td>
          <td class="num">${fmtNum(r.got)}</td>
          <td class="num"><b>${fmtNum(r.sub)}</b></td>
          <td class="num">${r.repeat ? fmtNum(r.repeat) : '–'}</td>
          <td class="num">${r.occasional ? fmtNum(r.occasional) : '–'}</td>
          <td class="num">${r.lost ? fmtNum(r.lost) : '–'}</td>
          <td class="num">${r.open ? `<b class="warn">${fmtNum(r.open)}</b>` : '–'}</td>
          <td class="num"><b class="${pct1(r.sub, r.got) >= 50 ? 'good' : ''}">${pct1(r.sub, r.got)}%</b></td>
          <td class="num"><b class="${pct1(r.sub + r.repeat, r.got) >= 50 ? 'good' : ''}">${pct1(r.sub + r.repeat, r.got)}%</b></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    <p class="panel__note">
      <b>% מנוי</b> הוא המטרה – הוראת קבע מתחדשת. <b>% המשיכו</b> מוסיף גם את מי שהזמין שבוע בודד נוסף:
      הוא שילם ואהב, הוא פשוט עוד לא התחייב, ולספור אותו ככישלון זה לא מדויק.<br>
      "מדי פעם" הם מי שאהב ולא רוצה מנוי שבועי – לא מנוי, אבל גם לא כישלון.<br>
      "פתוח" הם אנשים שקיבלו אוכל ועוד לא אמרו כן או לא – הם מחכים להחלטה שלך, לא שלהם.
    </p>
  </section>`;
}
function dayCard(a, everyone) {
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
    ${everyone ? `<p class="day__scope muted">לידים חמים בלבד. היום בסך הכל <b>${fmtNum(everyone.dials)}</b> חיוגים
      ו-<b>${fmtNum(everyone.fullCalls)}</b> שיחות מלאות – השאר אצל הלידים הקרים, <a href="#/magnet">במסך המגנט</a>.</p>` : ''}
    <div class="day__cells">
      ${cell('לידים חדשים', t.arrived, y.arrived)}
      ${cell('חיוגים', t.dials, y.dials)}
      ${cell('שיחות מלאות', t.fullCalls, y.fullCalls)}
      ${cell('סגירות', t.closes, y.closes, closeNote)}
    </div>
  </section>`;
}

// How much of the intake ever reaches a paid first week.
function trialCard(a) {
  const c = a.toTrial;
  if (!c.from) return '';
  const tone = c.pct >= 40 ? 'good' : c.pct >= 20 ? 'warn' : 'bad';
  return `<section class="conv conv--${tone}">
    <h2>מליד חדש לשבוע ניסיון</h2>
    <p class="conv__big">${c.pct}%</p>
    <p class="conv__body">
      נכנסו <b>${fmtNum(c.from)}</b> לידים. <b>${fmtNum(c.to)}</b> הגיעו לשבוע ניסיון או רחוק יותר.
      ${c.lost ? `${fmtNum(c.lost)} לא הגיעו לשם.` : ''}
    </p>
    ${c.disqualified ? `<p class="conv__note">${fmtNum(c.disqualified)} לא נספרים – מספר שגוי, כפילות, מחוץ לאזור החלוקה או משפיען שהועבר לרשימה</p>` : ''}
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
    ${w.parked ? `<p class="week__parked">${fmtNum(w.parked)} נוספים ממתינים בפולואפ עתידי ולא נספרים כאן</p>` : ''}
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
    .filter(l => l.status === 'active' && l.nextAt && !isParked(l) && daysBetween(today, l.nextAt) <= 0)
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
