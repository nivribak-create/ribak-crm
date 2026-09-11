import { STAGES, STAGE_BY_ID, SOURCES, stageIndex } from '../model.js';
import { computeAnalytics, RANGES } from '../analytics.js';
import { funnelRows, hbars, stackedColumns, meter } from '../charts.js';
import { esc, fmtNum, pct1, plural, dueLabel, daysBetween, fmtPhone, waLink, telLink } from '../util.js';
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

    <section class="kpis">
      ${kpi('לידים נכנסו', fmtNum(a.total), rangeNote())}
      ${kpi('סגרו מנוי', fmtNum(a.won), a.total ? `${a.convTotal}% מכלל הלידים` : '', 'won')}
      ${kpi('המרה כוללת', `${a.convTotal}%`, 'ליד חדש ← מנוי')}
      ${kpi('ניסיון ← מנוי', `${a.convTrial}%`, a.trialReached ? `${fmtNum(a.won)} מתוך ${fmtNum(a.trialReached)} שסגרו ניסיון` : 'עדיין אין שבועות ניסיון')}
      ${kpi('בטיפול עכשיו', fmtNum(a.active), a.lost ? `${fmtNum(a.lost)} אבדו` : '', 'active')}
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
