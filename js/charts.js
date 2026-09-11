// Chart builders. HTML for bars (they flow naturally in RTL), SVG for the
// time series. Colors come from CSS tokens so both themes work.
import { esc, fmtNum, pct1 } from './util.js';

// The leak funnel: one row per stage; the bar is everyone who reached it,
// split into "went on", "still here" and "lost here".
export function funnelRows(funnel, total) {
  if (!total) return `<div class="empty">אין לידים בטווח הזה</div>`;
  const max = funnel[0].reached || 1;
  return funnel.map((row, i) => {
    const w = v => `${(v / max) * 100}%`;
    const isLast = i === funnel.length - 1;
    const tip = `
      <strong>${esc(row.stage.label)}</strong>
      <div class="tip__row"><span>הגיעו לשלב</span><b>${fmtNum(row.reached)}</b></div>
      ${isLast
        ? `<div class="tip__row"><span>סגרו מנוי</span><b>${fmtNum(row.won)}</b></div>`
        : `<div class="tip__row"><span>המשיכו הלאה</span><b>${fmtNum(row.advanced)} (${row.conv}%)</b></div>
           <div class="tip__row"><span>עדיין כאן</span><b>${fmtNum(row.active)}</b></div>
           <div class="tip__row"><span>אבדו כאן</span><b>${fmtNum(row.lost)}</b></div>`}
      ${row.reasons.length ? `<div class="tip__sub">${row.reasons.slice(0, 3).map(r => `${esc(r.label)} · ${r.count}`).join('<br>')}</div>` : ''}`;
    const conv = isLast ? '' : `
      <div class="funnel__conv ${row.conv < 40 ? 'is-low' : ''}" title="המרה לשלב הבא">
        <span class="funnel__conv-arrow">↓</span> ${row.conv}%
        ${row.lost ? `<span class="funnel__leak">${fmtNum(row.lost)} אבדו</span>` : ''}
      </div>`;
    return `
      <div class="funnel__row" style="--i:${i}">
        <div class="funnel__label">
          <span class="funnel__name">${esc(row.stage.label)}</span>
          <span class="funnel__meta">${row.convFromStart}% מהלידים</span>
        </div>
        <div class="funnel__track" data-tip="${esc(tip)}">
          <div class="funnel__bar" style="width:${w(row.reached)}">
            ${isLast
              ? `<span class="funnel__seg funnel__seg--won" style="width:100%"></span>`
              : `<span class="funnel__seg funnel__seg--adv" style="width:${pct1(row.advanced, row.reached)}%"></span>
                 <span class="funnel__seg funnel__seg--act" style="width:${pct1(row.active, row.reached)}%"></span>
                 <span class="funnel__seg funnel__seg--lost" style="width:${pct1(row.lost, row.reached)}%"></span>`}
          </div>
          <span class="funnel__count">${fmtNum(row.reached)}</span>
        </div>
        ${conv}
      </div>`;
  }).join('');
}

// Horizontal bars, one hue, sorted by the caller.
export function hbars(items, { color = 'lost', valueLabel = v => fmtNum(v), sub = () => '' } = {}) {
  if (!items.length) return `<div class="empty">אין נתונים</div>`;
  const max = Math.max(...items.map(i => i.value)) || 1;
  return `<div class="hbars">${items.map(it => `
    <div class="hbar" ${it.tip ? `data-tip="${esc(it.tip)}"` : ''}>
      <div class="hbar__label"><span>${esc(it.label)}</span>${sub(it) ? `<small>${sub(it)}</small>` : ''}</div>
      <div class="hbar__track"><span class="hbar__fill hbar__fill--${color}" style="width:${(it.value / max) * 100}%"></span></div>
      <div class="hbar__value">${valueLabel(it.value, it)}</div>
    </div>`).join('')}</div>`;
}

// Stacked columns for weekly cohorts. Rendered LTR (time runs left→right).
export function stackedColumns(weeks, { height = 200 } = {}) {
  const W = 640, H = height, padL = 30, padR = 8, padT = 12, padB = 26;
  const n = weeks.length;
  const max = Math.max(1, ...weeks.map(w => w.total));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const iw = W - padL - padR, ih = H - padT - padB;
  const colW = iw / n, barW = Math.min(28, colW * 0.62);
  const y = v => padT + ih - (v / top) * ih;
  const fmtW = d => new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'numeric' }).format(d);

  const grid = [];
  for (let v = 0; v <= top; v += step) {
    grid.push(`<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="ch-grid"/>
               <text x="${padL - 6}" y="${y(v) + 4}" class="ch-tick" text-anchor="end">${v}</text>`);
  }
  const cols = weeks.map((w, i) => {
    const cx = padL + colW * i + colW / 2, x = cx - barW / 2;
    const segs = [];
    let acc = 0;
    const gap = 2;
    for (const [key, cls] of [['won', 'ch-won'], ['active', 'ch-active'], ['lost', 'ch-lost']]) {
      const v = w[key]; if (!v) continue;
      const y1 = y(acc + v), y2 = y(acc);
      const h = Math.max(0, y2 - y1 - (acc ? gap : 0));
      segs.push(`<rect x="${x}" y="${y1}" width="${barW}" height="${h}" rx="${h > 6 ? 3 : 0}" class="${cls}"/>`);
      acc += v;
    }
    const tip = `<strong>שבוע ${fmtW(w.start)}</strong>
      <div class="tip__row"><span>לידים</span><b>${w.total}</b></div>
      <div class="tip__row"><span>סגרו מנוי</span><b>${w.won}</b></div>
      <div class="tip__row"><span>בטיפול</span><b>${w.active}</b></div>
      <div class="tip__row"><span>אבדו</span><b>${w.lost}</b></div>`;
    const label = (n <= 8 || i % Math.ceil(n / 8) === 0) ? `<text x="${cx}" y="${H - 8}" class="ch-tick" text-anchor="middle">${fmtW(w.start)}</text>` : '';
    return `<g class="ch-col" data-tip="${esc(tip)}">
      <rect x="${padL + colW * i}" y="${padT}" width="${colW}" height="${ih}" fill="transparent"/>
      ${segs.join('')}
      ${w.total ? `<text x="${cx}" y="${y(w.total) - 5}" class="ch-val" text-anchor="middle">${w.total}</text>` : ''}
      ${label}
    </g>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart chart--columns" role="img" aria-label="לידים לפי שבוע">
    ${grid.join('')}
    <line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" class="ch-axis"/>
    ${cols.join('')}
  </svg>`;
}

function niceStep(max) {
  const raw = max / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return Math.max(1, nice * p);
}

// Tiny inline meter for tables.
export const meter = (v, max, cls = 'accent') =>
  `<span class="meter"><span class="meter__fill meter__fill--${cls}" style="width:${max ? (v / max) * 100 : 0}%"></span></span>`;
