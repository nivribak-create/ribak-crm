import { STAGES, STAGE_BY_ID, SOURCES, stageIndex, OUTCOMES } from '../model.js';
import { computeAnalytics, RANGES } from '../analytics.js';
import { funnelRows, hbars, stackedColumns, meter } from '../charts.js';
import { esc, fmtNum, pct1, plural, dueLabel, daysBetween, fmtPhone, waLink, telLink, deadlineLabel, fmtDateTime } from '../util.js';
import { handleAction, openDrawer } from '../lead.js';

const ui = {
  range: sessionStorage.getItem('ribak:range') || '90',
  source: sessionStorage.getItem('ribak:source') || '',
};

export function render(root, state) {
  const a = computeAnalytics(state.leads, ui);
  const hasAny = state.leads.length > 0;

  root.innerHTML = `
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

    ${!hasAny ? emptyState() : ''}

    ${hasAny ? readout(a) : ''}
    ${hasAny ? thisWeek(a) : ''}

    <h2 class="section-break">הנתונים המלאים</h2>

    <section class="kpis">
      ${kpi('לידים נכנסו', fmtNum(a.total), rangeNote())}
      ${kpi('מנויים פעילים', fmtNum(a.won), a.churned ? `${fmtNum(a.churned)} הפסיקו מאז` : a.total ? `${a.convTotal}% מכלל הלידים` : '', 'won')}
      ${kpi('המרה כוללת', `${a.convTotal}%`, 'ליד חדש ← מנוי')}
      ${kpi('ניסיון ← מנוי', `${a.convTrial}%`, a.trialReached ? `${fmtNum(a.sold)} מתוך ${fmtNum(a.trialReached)} שקיבלו אוכל` : 'עדיין אין שבועות ניסיון')}
      ${kpi('נטישת מנויים', a.sold ? `${a.churnRate}%` : '—', a.sold ? `${fmtNum(a.churned)} מתוך ${fmtNum(a.sold)} שסגרו מנוי` : 'אין עדיין מנויים', a.churnRate >= 25 ? 'alert' : '')}
      ${kpi('פולואפים להיום', fmtNum(a.due.today + a.due.overdue), a.due.overdue ? `${fmtNum(a.due.overdue)} באיחור` : a.due.upcoming ? `${fmtNum(a.due.upcoming)} בהמשך השבוע` : '', a.due.overdue ? 'alert' : '')}
    </section>

    <section class="panel panel--funnel">
      <header class="panel__head">
        <div>
          <h2>המשפך</h2>
          <p class="muted">כמה לידים הגיעו לכל שלב, כמה המשיכו, ואיפה הם נופלים</p>
        </div>
        <ul class="legend">
          <li><i class="sw sw--adv"></i>המשיכו לשלב הבא</li>
          <li><i class="sw sw--act"></i>עדיין בשלב</li>
          <li><i class="sw sw--lost"></i>אבדו בשלב</li>
          <li><i class="sw sw--won"></i>סגרו מנוי</li>
        </ul>
      </header>
      <div class="funnel">${funnelRows(a.funnel, a.total)}</div>
    </section>

    <section class="panel">
      <header class="panel__head">
        <div><h2>מה יצא מהלידים</h2><p class="muted">כל ליד בטווח, לפי מה שקרה איתו בסוף. לחיצה פותחת את הרשימה</p></div>
      </header>
      ${outcomeBars(a)}
    </section>

    <div class="grid-2">
      <section class="panel">
        <header class="panel__head"><div><h2>למה לידים נופלים</h2><p class="muted">${a.lost ? `${fmtNum(a.lost)} ${plural(a.lost, 'ליד אבד', 'לידים אבדו')} בטווח` : 'אין לידים אבודים בטווח'}</p></div></header>
        ${hbars(a.reasons.map(r => ({
          label: r.label, value: r.count,
          share: r.share, topStage: r.topStage,
          tip: `<strong>${esc(r.label)}</strong><div class="tip__row"><span>לידים</span><b>${r.count}</b></div><div class="tip__row"><span>מכלל האבודים</span><b>${r.share}%</b></div>`,
        })), { color: 'lost', valueLabel: (v, it) => `${fmtNum(v)} <small>${it.share}%</small>`, sub: it => it.topStage ? `בעיקר בשלב ${esc(STAGE_BY_ID[it.topStage]?.short || '')}` : '' })}
      </section>

      <section class="panel">
        <header class="panel__head">
          <div><h2>לידים לפי שבוע</h2><p class="muted">כל עמודה – הלידים שנכנסו באותו שבוע ומה קרה איתם</p></div>
          <ul class="legend legend--sm">
            <li><i class="sw sw--won"></i>מנוי</li><li><i class="sw sw--act"></i>בטיפול</li><li><i class="sw sw--lost"></i>אבד</li>
          </ul>
        </header>
        <div class="chart-wrap">${stackedColumns(a.weekly)}</div>
      </section>
    </div>

    <div class="grid-2">
      <section class="panel">
        <header class="panel__head"><div><h2>לפי מקור</h2><p class="muted">מאיפה מגיעים הלידים שסוגרים</p></div></header>
        ${sourcesTable(a)}
      </section>

      <section class="panel">
        <header class="panel__head"><div><h2>קצב</h2><p class="muted">כמה זמן לוקח כל שלב, וכמה ניסיונות נדרשים</p></div></header>
        ${paceTable(a)}
      </section>
    </div>

    ${a.influencers.length ? `
    <section class="panel">
      <header class="panel__head"><div><h2>לפי משפיען</h2><p class="muted">איזה שיתוף פעולה הביא מנויים, לא רק חשיפה</p></div></header>
      ${influencerTable(a)}
    </section>` : ''}

    <section class="panel">
      <header class="panel__head"><div><h2>לחזור אליהם היום</h2><p class="muted">לידים בטיפול עם פעולה מתוכננת להיום או באיחור</p></div></header>
      ${dueList(state.leads)}
    </section>`;

  root.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => {
    ui.range = b.dataset.range; sessionStorage.setItem('ribak:range', ui.range); render(root, state);
  }));
  root.querySelector('[data-source]').addEventListener('change', e => {
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

function kpi(label, value, sub = '', kind = '') {
  return `<div class="kpi ${kind ? 'kpi--' + kind : ''}">
    <span class="kpi__label">${esc(label)}</span>
    <span class="kpi__value">${value}</span>
    ${sub ? `<span class="kpi__sub">${esc(sub)}</span>` : '<span class="kpi__sub"></span>'}
  </div>`;
}

const OUTCOME_CLASS = { open: 'active', subscriber: 'won', churned: 'churn', repeat_only: 'warn', trial_only: 'lost', never_paid: 'lost' };

// Said in sentences, because the numbers on their own were leaving the
// reader to work out what they meant.
function readout(a) {
  const say = [];

  if (a.leak) {
    const s = a.leak.stage;
    const next = STAGES[a.leak.index + 1];
    say.push({
      tone: 'bad',
      head: `הכי הרבה לידים נופלים בשלב <b>${esc(s.label)}</b>`,
      body: next
        ? `${fmtNum(a.leak.reached)} הגיעו לשלב הזה, ${fmtNum(a.leak.advanced)} המשיכו ל${esc(next.label)}, ו-<b>${fmtNum(a.leak.lost)} נפלו כאן</b>.`
        : `${fmtNum(a.leak.lost)} לקוחות הפסיקו אחרי שכבר היו מנויים.`,
    });
  }

  say.push({
    tone: a.sellTrial.pct >= 40 ? 'good' : 'warn',
    head: 'מכירת שבוע ניסיון',
    body: a.sellTrial.from
      ? `דיברת עם ${fmtNum(a.sellTrial.from)} לידים בטלפון. <b>${fmtNum(a.sellTrial.to)} שילמו</b> על שבוע ניסיון – ${a.sellTrial.pct}%. ${fmtNum(a.sellTrial.lost)} לא סגרו.`
      : 'עוד לא בוצעו שיחות מכירה בטווח הזה.',
  });

  say.push({
    tone: a.sellSub.pct >= 50 ? 'good' : 'warn',
    head: 'המרה ממנו למנוי',
    body: a.sellSub.from
      ? `${fmtNum(a.sellSub.from)} לקוחות קיבלו את האוכל. <b>${fmtNum(a.sellSub.to)} סגרו מנוי</b> – ${a.sellSub.pct}%. ${fmtNum(a.sellSub.lost)} לא המשיכו.`
      : 'עוד אף אחד לא קיבל משלוח בטווח הזה.',
  });

  if (a.topReason) {
    say.push({
      tone: 'plain',
      head: `הסיבה שחוזרת הכי הרבה: <b>${esc(a.topReason.label)}</b>`,
      body: `${fmtNum(a.topReason.count)} ${plural(a.topReason.count, 'ליד', 'לידים')} – ${a.topReason.share}% מכל מי שאבד.`,
    });
  }

  say.push({
    tone: 'plain',
    head: 'בשורה התחתונה',
    body: a.total
      ? `מתוך ${fmtNum(a.total)} לידים שנכנסו, <b>${fmtNum(a.sold)} הפכו למנויים</b> – ${a.convTotal}%, כלומר אחד מכל ${fmtNum(Math.max(1, Math.round(a.total / Math.max(1, a.sold))))}.`
      : 'אין לידים בטווח הזה.',
  });

  return `<section class="readout">
    ${say.map(x => `
      <div class="read read--${x.tone}">
        <p class="read__head">${x.head}</p>
        <p class="read__body">${x.body}</p>
      </div>`).join('')}
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

function paceTable(a) {
  const fmtD = d => d == null ? '—' : d < 1 ? `${Math.round(d * 24)} שע׳` : `${Math.round(d * 10) / 10} ימים`;
  const rows = a.stageDays.map(s => `<tr>
    <td>${esc(s.from.short)} ← ${esc(s.to.short)}</td>
    <td class="num">${fmtD(s.medianDays)}</td>
    <td class="num muted">${s.n ? fmtNum(s.n) : '—'}</td>
  </tr>`).join('');
  const attempts = a.attempts.byStage.filter(x => x.count);
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>מעבר</th><th class="num">זמן חציוני</th><th class="num">לידים</th></tr></thead>
    <tbody>${rows}
      <tr class="table__total"><td>ליד חדש ← מנוי</td><td class="num">${fmtD(a.avgDaysToWin)}</td><td class="num muted">${a.won ? fmtNum(a.won) : '—'}</td></tr>
    </tbody>
  </table></div>
  <div class="pace-attempts">
    <div class="pace-attempts__head"><b>${fmtNum(a.attempts.total)}</b> ${plural(a.attempts.total, 'ניסיון ללא מענה', 'ניסיונות ללא מענה')} <span class="muted">אצל ${fmtNum(a.attempts.leads)} לידים</span></div>
    ${attempts.length ? `<div class="pace-attempts__list">${attempts.map(x => `<span class="tag">${esc(x.stage.short)} · ${x.count}</span>`).join('')}</div>` : ''}
  </div>`;
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
