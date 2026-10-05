// Cold leads from the magnet — people who left their details behind an
// influencer's link to get whatever it promised. They never asked about the
// food and nobody has spoken to them, so judging them by the same numbers
// as someone who called asking to order flatters neither side. This screen
// keeps them apart, and its one real question is whether the traffic an
// influencer sends is worth the hours it takes to call it.

import { STAGES, stageIndex, reasonLabel, DISQUALIFYING, everSubscribed, viaMagnet, untouched } from '../model.js';
import { computeAnalytics } from '../analytics.js';
import { hbars } from '../charts.js';
import { esc, fmtNum, pct1, fmtDateLong, isoDay, addDays } from '../util.js';
import { openDrawer } from '../lead.js';

export function render(root, state) {
  const mine = state.leads.filter(viaMagnet);

  if (!mine.length) {
    root.innerHTML = `
      <div class="hero-empty">
        <h2>עוד לא נכנסו לידים מהמגנט</h2>
        <p>כל מי שמשאיר שם וטלפון בעמוד שמאחורי לינק של משפיען יגיע לכאן, וייספר בנפרד מהלידים
          שפונים אליך בעצמם – כדי ששתי המערכות לא יקלקלו אחת לשנייה את המספרים.</p>
      </div>`;
    return;
  }

  const m = computeAnalytics(state.leads, { range: 'all', cohort: 'magnet' });
  const w = computeAnalytics(state.leads, { range: 'all', cohort: 'warm' });
  const today = isoDay(new Date());

  root.innerHTML = `
    <section class="panel panel--intro">
      <h2>לידים קרים מהמגנט</h2>
      <p class="muted">אנשים שהשאירו שם וטלפון מאחורי לינק של משפיען. הם לא פנו אליך, לא מכירים את המוצר,
        ולא ביקשו שתתקשר – ולכן הם נספרים לחוד, ולא מופיעים במספרים שבלוח הבקרה.</p>
    </section>

    ${arrivals(mine, m, today)}
    ${funnelCard(m)}
    ${compare(m, w)}
    ${todo(mine)}

    <section class="panel">
      <header class="panel__head"><div><h2>לפי משפיען</h2>
        <p class="muted">מי מביא קהל שבאמת קונה, ולא רק קהל שמשאיר טלפון</p></div></header>
      ${byInfluencer(mine)}
    </section>

    ${dropouts(mine)}`;

  root.onclick = e => {
    const row = e.target.closest('[data-lead]');
    if (row) openDrawer(row.dataset.lead);
  };
}

// ---- what came in -------------------------------------------------------
function arrivals(mine, m, today) {
  const yday = isoDay(addDays(new Date(), -1));
  const cell = (label, value, note) => `
    <div class="day__cell"><b>${fmtNum(value)}</b><span>${esc(label)}</span><small>${esc(note)}</small></div>`;
  const arrivedToday = mine.filter(l => isoDay(l.createdAt) === today).length;
  const arrivedYday = mine.filter(l => isoDay(l.createdAt) === yday).length;
  return `<section class="day">
    <header class="day__head">
      <h2>המגנט היום</h2>
      <span class="muted">${esc(fmtDateLong(new Date().toISOString()))}</span>
    </header>
    <div class="day__cells">
      ${cell('נכנסו היום', arrivedToday, `אתמול ${fmtNum(arrivedYday)}`)}
      ${cell('חיוגים', m.today.dials, `אתמול ${fmtNum(m.yesterday.dials)}`)}
      ${cell('שיחות מלאות', m.today.fullCalls, `אתמול ${fmtNum(m.yesterday.fullCalls)}`)}
      ${cell('סגירות', m.today.closes, `אתמול ${fmtNum(m.yesterday.closes)}`)}
    </div>
  </section>`;
}

// ---- how far they get ---------------------------------------------------
function funnelCard(m) {
  const at = id => m.funnel[stageIndex(id)].reached;
  const steps = [
    { label: 'נכנסו', n: m.total },
    { label: 'דיברת איתם', n: at('pitched') },
    { label: 'שבוע ניסיון', n: at('trial') },
    { label: 'מנוי', n: m.funnel[stageIndex('subscribed')].reached },
  ];
  const max = steps[0].n || 1;
  return `<section class="panel">
    <header class="panel__head"><div><h2>כמה רחוק הם מגיעים</h2>
      <p class="muted">מתוך ${fmtNum(m.total)} לידים קרים שנכנסו</p></div></header>
    <div class="mfunnel">
      ${steps.map((s, i) => `
        <div class="mfunnel__row">
          <span class="mfunnel__label">${esc(s.label)}</span>
          <span class="mfunnel__bar"><i style="width:${Math.max(2, Math.round((s.n / max) * 100))}%"></i></span>
          <b class="mfunnel__n">${fmtNum(s.n)}</b>
          <small class="muted">${i ? `${pct1(s.n, max)}%` : ''}</small>
        </div>`).join('')}
    </div>
  </section>`;
}

// ---- cold against warm --------------------------------------------------
function compare(m, w) {
  const row = (label, a) => `
    <tr>
      <td>${esc(label)}</td>
      <td class="num">${fmtNum(a.toTrial.from)}</td>
      <td class="num">${fmtNum(a.toTrial.to)}</td>
      <td class="num"><b class="${a.toTrial.pct >= 10 ? 'good' : ''}">${a.toTrial.pct}%</b></td>
    </tr>`;
  const gap = w.toTrial.pct && m.toTrial.pct
    ? (w.toTrial.pct / m.toTrial.pct).toFixed(1) : null;
  return `<section class="panel">
    <header class="panel__head"><div><h2>קר מול חם</h2>
      <p class="muted">כמה מכל סוג ליד הגיעו לשבוע ניסיון. לידים שנפסלו כלא רלוונטיים לא נספרים.</p></div></header>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>סוג</th><th class="num">לידים</th><th class="num">ניסיון</th><th class="num">המרה</th></tr></thead>
      <tbody>
        ${row('קרים – מהמגנט', m)}
        ${row('חמים – פנו בעצמם', w)}
      </tbody>
    </table></div>
    ${gap && Number(gap) > 1
      ? `<p class="panel__note">ליד חם שווה פי ${esc(gap)} מליד קר. אם שעה של חיוגים מביאה את אותו מספר שיחות,
          כדאי שהיא תלך קודם לחמים.</p>`
      : ''}
  </section>`;
}

// ---- what is waiting ----------------------------------------------------
function todo(mine) {
  const waiting = mine.filter(untouched);
  if (!waiting.length) {
    return `<section class="conv conv--good"><h2>אין אף אחד שלא נגעת בו</h2>
      <p class="conv__body">כל הלידים הקרים שנכנסו כבר קיבלו טיפול.</p></section>`;
  }
  const oldest = waiting.reduce((a, b) => (a.createdAt < b.createdAt ? a : b));
  return `<section class="conv conv--warn">
    <h2>מחכים לשיחה ראשונה</h2>
    <p class="conv__big">${fmtNum(waiting.length)}</p>
    <p class="conv__body">
      לידים קרים שעוד לא נגעת בהם. הוותיק מביניהם נכנס ${esc(fmtDateLong(oldest.createdAt))}.
      <a href="#/pipeline">לפייפליין ←</a>
    </p>
  </section>`;
}

// ---- per influencer -----------------------------------------------------
function byInfluencer(mine) {
  const names = [...new Set(mine.map(l => l.influencer).filter(Boolean))];
  const rows = names.map(name => {
    const ls = mine.filter(l => l.influencer === name);
    const dq = ls.filter(l => l.status === 'lost' && DISQUALIFYING.has(l.lostReason)).length;
    const real = ls.length - dq;
    return {
      name,
      total: ls.length,
      dq,
      real,
      talked: ls.filter(l => stageIndex(l.stage) >= stageIndex('pitched')).length,
      trial: ls.filter(l => stageIndex(l.stage) >= stageIndex('trial')).length,
      won: ls.filter(everSubscribed).length,
      conv: pct1(ls.filter(l => stageIndex(l.stage) >= stageIndex('trial')).length, real),
    };
  }).sort((a, b) => b.total - a.total);

  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>משפיען</th><th class="num">לידים</th><th class="num">לא רלוונטי</th><th class="num">דיברת</th><th class="num">ניסיון</th><th class="num">מנוי</th><th class="num">המרה</th></tr></thead>
    <tbody>
      ${rows.map(r => `<tr>
        <td dir="ltr" style="text-align:start">${esc(r.name)}</td>
        <td class="num">${fmtNum(r.total)}</td>
        <td class="num">${r.dq ? `<span class="muted">${fmtNum(r.dq)}</span>` : '–'}</td>
        <td class="num">${fmtNum(r.talked)}</td>
        <td class="num">${fmtNum(r.trial)}</td>
        <td class="num">${fmtNum(r.won)}</td>
        <td class="num"><b class="${r.conv >= 10 ? 'good' : ''}">${r.conv}%</b></td>
      </tr>`).join('')}
    </tbody>
  </table></div>
  <p class="panel__note">ההמרה מחושבת מתוך הלידים שנשארו אחרי שהורדנו את הלא רלוונטיים.</p>`;
}

// ---- why they fell out --------------------------------------------------
function dropouts(mine) {
  const lost = mine.filter(l => l.status === 'lost' || l.status === 'churned');
  if (!lost.length) return '';
  const counted = [...new Set(lost.map(l => l.lostReason))].map(id => {
    const ls = lost.filter(l => l.lostReason === id);
    const topStage = [...new Set(ls.map(l => l.stage))]
      .map(st => [st, ls.filter(l => l.stage === st).length])
      .sort((a, b) => b[1] - a[1])[0];
    return {
      label: reasonLabel(id),
      value: ls.length,
      share: pct1(ls.length, lost.length),
      stage: topStage ? STAGES.find(s => s.id === topStage[0])?.short : '',
    };
  }).sort((a, b) => b.value - a.value);

  return `<section class="panel">
    <header class="panel__head"><div><h2>למה הם נפלו</h2>
      <p class="muted">${fmtNum(lost.length)} מתוך ${fmtNum(mine.length)} לידים קרים</p></div></header>
    ${hbars(counted, {
    color: 'lost',
    valueLabel: (v, it) => `${fmtNum(v)} <small>${it.share}%</small>`,
    sub: it => (it.stage ? `בעיקר בשלב ${esc(it.stage)}` : ''),
  })}
  </section>`;
}
