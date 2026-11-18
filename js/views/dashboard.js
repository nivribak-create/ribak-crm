import { STAGE_BY_ID, SOURCES, OUTCOMES, viaMagnet, deliveryWeek, subscriptionWeek, stageIndex, everSubscribed, adInfo, isPaying, paidTotal, AD_ARMS, AD_VIDEOS, awaitingCallback, testAds } from '../model.js';
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
    ${hasAny ? campaignPanel(state.leads) : ''}

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
  root.querySelector('[data-ad-spend]')?.addEventListener('click', openSpendDialog);
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
    const ad = adInfo(l.adId, names, l.adNames);
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
          <td>${ad.known ? esc(ad.code ? `${ad.code} · ${ad.videoName}` : ad.label) + (ad.creator ? ` <small class="muted">${esc(ad.creator)}</small>` : '') : `<span class="warn">לא מזוהה</span> <small class="muted" dir="ltr">${esc(ad.id)}</small>`}${ad.campaign ? `<br><small class="muted">${esc(ad.campaign)}</small>` : ''}</td>
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
// ---- what the campaign brings in ----------------------------------------
// One line per ad, read left to right as the money does: what it cost, how
// many leads that bought, how many of them closed, what they paid.
const shekel = n => `₪${n < 100 ? fmtNum(Math.round(n * 10) / 10) : fmtNum(Math.round(n))}`;

function campaignRows(leads) {
  const names = store.getAds();
  const spend = store.getAdSpend();
  const blank = (label, sub = '') => ({ label, sub, spend: null, leads: 0, trial: 0, subs: 0, revenue: 0, noAmount: 0 });
  const ads = testAds().map(ad => ({ ...blank(ad.code, `${ad.videoName} · ${ad.creator}`), ad,
    spend: Number.isFinite(spend.byAd[ad.id]) ? spend.byAd[ad.id] : null }));
  const byId = new Map(ads.map(r => [r.ad.id, r]));
  const unknown = new Map();
  const count = (r, l) => {
    r.leads++;
    if (isPaying(l)) { r.trial++; if (!paidTotal(l)) r.noAmount++; }
    if (everSubscribed(l)) r.subs++;
    r.revenue += paidTotal(l);
  };
  for (const l of leads) {
    if (l.contactOnly) continue;
    const ad = adInfo(l.adId, names, l.adNames);
    if (ad && byId.has(ad.id)) { count(byId.get(ad.id), l); continue; }
    if (ad && ad.retired) continue;
    if (ad && !ad.known) unknown.set(ad.id, (unknown.get(ad.id) || 0) + 1);
  }
  const sum = (label, rows, sub = '') => rows.reduce((t, r) => ({
    ...t, leads: t.leads + r.leads, trial: t.trial + r.trial, subs: t.subs + r.subs, revenue: t.revenue + r.revenue,
    noAmount: t.noAmount + r.noAmount,
    spend: r.spend === null ? t.spend : (t.spend || 0) + r.spend,
  }), blank(label, sub));
  // Only a lead that arrived by itself, carrying the id of one of the test's
  // ads, is counted. Anything typed in by hand or without an id is left out:
  // it cannot be tied to the test, and a guess would only blur the comparison.
  const arms = AD_ARMS.map(a => ({ arm: a, rows: ads.filter(r => r.ad.arm === a.id) }))
    .map(g => ({ ...g, total: sum(`${g.arm.label} · סה"כ`, g.rows) }));
  const creators = [...new Set(AD_VIDEOS.map(v => v.creator))]
    .map(name => sum(name, ads.filter(r => r.ad.creator === name), `סרטונים ${AD_VIDEOS.filter(v => v.creator === name).map(v => v.n).join('+')}`));
  return { arms, creators, unknown, spendAt: spend.at, total: sum('סה"כ הבדיקה', ads) };
}

function campaignPanel(leads) {
  const c = campaignRows(leads);
  const t = c.total;
  if (!t.leads && t.spend === null && !c.unknown.size) return '';
  const per = (a, b) => (a !== null && b ? shekel(a / b) : '–');
  const line = (r, cls = '') => `<tr class="${cls}">
      <td>${esc(r.label)}${r.sub ? ` <small class="muted">${esc(r.sub)}</small>` : ''}</td>
      <td class="num">${r.spend === null ? '–' : shekel(r.spend)}</td>
      <td class="num">${fmtNum(r.leads)}</td>
      <td class="num">${per(r.spend, r.leads)}</td>
      <td class="num">${r.trial ? `<b>${fmtNum(r.trial)}</b> <small class="muted">${pct1(r.trial, r.leads)}%</small>` : '0'}</td>
      <td class="num">${per(r.spend, r.trial)}</td>
      <td class="num">${fmtNum(r.subs)}</td>
      <td class="num">${r.revenue ? shekel(r.revenue) : '–'}</td>
      <td class="num">${r.spend && r.revenue ? `×${(r.revenue / r.spend).toFixed(1)}` : '–'}</td>
    </tr>`;
  const tile = (label, value, sub = '') => `<div class="kpi"><span class="kpi__label">${label}</span><span class="kpi__value">${value}</span><span class="kpi__sub">${sub}</span></div>`;
  const ids = [...c.unknown.keys()];
  const missing = t.noAmount;
  return `<section class="panel">
    <header class="panel__head"><div><h2>כמה הקמפיין מכניס</h2>
      <p class="muted">הבדיקה שעלתה ב-16.11 בלבד · דף נחיתה מול DM · מה כל מודעה עלתה, כמה לידים הביאה, כמה סגרו וכמה שילמו</p></div>
      <div><button class="btn btn--sm" data-ad-spend>עדכון הוצאה ממטא</button>
        <p class="muted">${c.spendAt ? `הוצאה מעודכנת ל-${esc(fmtDateTime(c.spendAt))}` : 'ההוצאה עוד לא הוזנה'}</p></div></header>
    ${ids.length ? `<p class="ad-alert"><b>${fmtNum(ids.length)} ${ids.length === 1 ? 'מזהה מודעה לא מזוהה' : 'מזהי מודעות לא מזוהים'}</b>
      (${(n => plural(n, 'ליד אחד', `${fmtNum(n)} לידים`))([...c.unknown.values()].reduce((a, b) => a + b, 0))}) – צריך לשלוח למי שמנהל את הקמפיין:
      <span dir="ltr">${ids.map(esc).join(', ')}</span> ${copyBtn(ids.join(', '), 'העתקת המזהים')}</p>` : ''}
    <div class="kpis kpis--camp">
      ${tile('הוצאה', t.spend === null ? '–' : shekel(t.spend))}
      ${tile('לידים', fmtNum(t.leads), t.spend !== null && t.leads ? `${shekel(t.spend / t.leads)} לליד` : '')}
      ${tile('סגרו ניסיון', fmtNum(t.trial), t.spend !== null && t.trial ? `${shekel(t.spend / t.trial)} ללקוח` : '')}
      ${tile('מנויים', fmtNum(t.subs))}
      ${tile('הכנסה', t.revenue ? shekel(t.revenue) : '–', missing > 0 ? `${plural(missing, 'ללקוח אחד', `ל-${fmtNum(missing)} לקוחות`)} לא נרשם סכום` : '')}
      ${tile('החזר', t.spend && t.revenue ? `×${(t.revenue / t.spend).toFixed(1)}` : '–', t.spend && t.revenue ? 'הכנסה חלקי הוצאה' : '')}
    </div>
    <div class="table-wrap"><table class="table table--camp">
      <thead><tr><th>מודעה</th><th class="num">הוצאה</th><th class="num">לידים</th><th class="num">עלות לליד</th>
        <th class="num">סגרו ניסיון</th><th class="num">עלות ללקוח</th><th class="num">מנויים</th><th class="num">הכנסה</th><th class="num">החזר</th></tr></thead>
      <tbody>
        ${c.arms.map(g => g.rows.map(r => line(r)).join('') + line(g.total, 'camp-sum')).join('')}
        ${c.creators.map((r, i) => line(r, `camp-creator ${i ? '' : 'camp-first'}`)).join('')}
        ${line(t, 'camp-total')}
      </tbody>
    </table></div>
    <p class="panel__note">סגר ניסיון = הגיע לשלב "סגר שבוע ניסיון" ומעלה, או שנרשם לו תשלום. הכנסה = הסכומים שנרשמו בכרטיסי הלקוחות.
      החזר = הכנסה חלקי הוצאה. נספרים רק לידים שנכנסו לבד עם מזהה של אחת ממודעות הבדיקה; לידים שהוקלדו ידנית או הגיעו בלי מזהה לא נספרים.</p>
  </section>`;
}

function openSpendDialog() {
  const spend = store.getAdSpend();
  const m = openModal({
    title: 'הוצאה לכל מודעה',
    body: `
      <form class="form form--spend" id="spend-form">
        <p class="modal__text">כמה כל מודעה עלתה עד עכשיו, בשקלים, כמו שמופיע במטא בעמודת "הסכום שהוצא".</p>
        ${testAds().map(ad => field(`${ad.code} · ${ad.armLabel} · ${ad.videoName}`,
          `<input class="input" name="${esc(ad.id)}" type="number" inputmode="decimal" min="0" step="any" value="${esc(spend.byAd[ad.id] ?? '')}">`)).join('')}
      </form>`,
    footer: `<button class="btn" data-close>ביטול</button><button class="btn btn--primary" type="submit" form="spend-form">שמירה</button>`,
  });
  m.el.querySelector('#spend-form').addEventListener('submit', e => {
    e.preventDefault();
    store.saveAdSpend(formData(e.target));
    toast('ההוצאה עודכנה', 'good');
    m.close();
  });
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
  // A "yes" pressed in a round message waits for one WhatsApp back.
  const yes = leads.filter(l => awaitingCallback(l));
  const yesRows = yes.map(l => `<li class="due" data-open="${l.id}">
      <div class="due__main">
        <b>${esc(l.name)}</b>
        <span class="muted">ענה כן להודעת הסבב${awaitingCallback(l).week ? ` · משלוח ${esc(fmtDate(awaitingCallback(l).week))}` : ''}</span>
      </div>
      <span class="tag tag--done">לחזור אליו</span>
      <div class="due__contact">
        <a class="contact contact--tel" href="${telLink(l.phone)}" onclick="event.stopPropagation()">📞</a>
        ${copyBtn(l.phone)}
        <a class="contact contact--wa" href="${waLink(l.phone)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">וואטסאפ</a>
      </div>
    </li>`).join('');
  if (!due.length && !yes.length) return `<div class="empty">אין פולואפים שממתינים להיום. 👌</div>`;
  return `<ul class="due-list">${yesRows}${due.map(l => {
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
