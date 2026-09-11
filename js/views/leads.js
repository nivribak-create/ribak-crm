import { STAGES, STAGE_BY_ID, SOURCES, STATUS, reasonLabel, stageIndex } from '../model.js';
import { esc, fmtPhone, fmtDate, waLink, telLink, daysBetween, dueLabel, fmtNum, downloadText } from '../util.js';
import { handleAction, openDrawer } from '../lead.js';

const ui = { q: '', status: '', stage: '', source: '', sort: 'createdAt', dir: -1 };

export function render(root, state) {
  root.innerHTML = `
    <div class="toolbar">
      <input class="input input--sm input--search" type="search" placeholder="חיפוש לפי שם, טלפון או הערה" value="${esc(ui.q)}" data-f="q" aria-label="חיפוש">
      <select class="input input--sm" data-f="status" aria-label="סטטוס">
        <option value="">כל הסטטוסים</option>
        ${Object.values(STATUS).map(s => `<option value="${s.id}" ${ui.status === s.id ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
      </select>
      <select class="input input--sm" data-f="stage" aria-label="שלב">
        <option value="">כל השלבים</option>
        ${STAGES.map(s => `<option value="${s.id}" ${ui.stage === s.id ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
      </select>
      <select class="input input--sm" data-f="source" aria-label="מקור">
        <option value="">כל המקורות</option>
        ${SOURCES.map(s => `<option value="${esc(s)}" ${ui.source === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
      <span class="toolbar__note muted" data-count></span>
      <button class="btn btn--sm" data-export>ייצוא CSV</button>
    </div>
    <div class="table-wrap table-wrap--leads"><table class="table table--leads">
      <thead><tr>
        ${th('name', 'שם')}${th('phone', 'טלפון', false)}${th('source', 'מקור')}${th('stage', 'שלב')}${th('status', 'סטטוס')}${th('createdAt', 'נכנס')}${th('nextAt', 'פעולה הבאה')}
      </tr></thead>
      <tbody data-body></tbody>
    </table></div>`;

  const body = root.querySelector('[data-body]');
  const draw = () => {
    const rows = filtered(state.leads);
    root.querySelector('[data-count]').textContent = `${fmtNum(rows.length)} לידים`;
    body.innerHTML = rows.length ? rows.map(row).join('') : `<tr><td colspan="7"><div class="empty">לא נמצאו לידים שמתאימים לסינון</div></td></tr>`;
  };
  draw();

  root.querySelectorAll('[data-f]').forEach(el => el.addEventListener('input', e => { ui[el.dataset.f] = e.target.value; draw(); }));
  root.querySelectorAll('[data-sort]').forEach(h => h.addEventListener('click', () => {
    const k = h.dataset.sort;
    if (ui.sort === k) ui.dir = -ui.dir; else { ui.sort = k; ui.dir = k === 'name' || k === 'source' ? 1 : -1; }
    root.querySelectorAll('[data-sort]').forEach(x => x.classList.toggle('is-sorted', x.dataset.sort === ui.sort));
    draw();
  }));
  root.querySelector('[data-export]').addEventListener('click', () => exportCsv(filtered(state.leads)));
  root.onclick = e => {
    if (e.target.closest('a') || e.target.closest('[data-sort]') || e.target.closest('.toolbar')) return;
    if (handleAction(e)) return;
    const tr = e.target.closest('tr[data-id]');
    if (tr) openDrawer(tr.dataset.id);
  };
}

function th(key, label, sortable = true) {
  return sortable
    ? `<th data-sort="${key}" class="${ui.sort === key ? 'is-sorted' : ''}"><button class="th-btn">${esc(label)}</button></th>`
    : `<th>${esc(label)}</th>`;
}

function filtered(leads) {
  const q = ui.q.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  return leads.filter(l =>
    (!q || l.name.toLowerCase().includes(q) || (qDigits && l.phone.replace(/\D/g, '').includes(qDigits)) || (l.notes || '').toLowerCase().includes(q)) &&
    (!ui.status || l.status === ui.status) &&
    (!ui.stage || l.stage === ui.stage) &&
    (!ui.source || l.source === ui.source),
  ).sort((a, b) => {
    let x = a[ui.sort], y = b[ui.sort];
    if (ui.sort === 'stage') { x = stageIndex(a.stage); y = stageIndex(b.stage); }
    if (ui.sort === 'status') { const o = { active: 0, won: 1, lost: 2 }; x = o[a.status]; y = o[b.status]; }
    if (x == null) return 1; if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * ui.dir;
  });
}

function row(l) {
  const today = new Date();
  const due = l.nextAt ? daysBetween(today, l.nextAt) : null;
  const status = l.status === 'won' ? `<span class="tag tag--won">סגר מנוי</span>`
    : l.status === 'lost' ? `<span class="tag tag--lost" title="${esc(reasonLabel(l.lostReason))}">אבד</span>`
    : `<span class="tag tag--active">בטיפול</span>`;
  return `<tr data-id="${l.id}" tabindex="0">
    <td class="td-name"><b>${esc(l.name)}</b>${l.status === 'lost' ? `<small class="muted">${esc(reasonLabel(l.lostReason))}</small>` : l.notes ? `<small class="muted">${esc(l.notes)}</small>` : ''}</td>
    <td class="td-phone"><a href="${telLink(l.phone)}">${esc(fmtPhone(l.phone))}</a> <a class="wa-mini" href="${waLink(l.phone)}" target="_blank" rel="noopener" title="וואטסאפ">וואטסאפ</a></td>
    <td>${esc(l.source)}</td>
    <td><span class="stage-chip" style="--c:var(--f${stageIndex(l.stage)})">${esc(STAGE_BY_ID[l.stage].short)}</span></td>
    <td>${status}</td>
    <td class="num muted">${fmtDate(l.createdAt)}</td>
    <td>${l.nextAt && l.status === 'active' ? `<span class="tag ${due < 0 ? 'tag--lost' : due === 0 ? 'tag--warn' : ''}">${esc(dueLabel(l.nextAt))}</span>` : '<span class="muted">—</span>'}</td>
  </tr>`;
}

function exportCsv(leads) {
  const head = ['שם', 'טלפון', 'מקור', 'שלב', 'סטטוס', 'סיבת אובדן', 'נכנס', 'פעולה הבאה', 'ניסיונות ללא מענה', 'הערות'];
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = leads.map(l => [
    l.name, l.phone, l.source, STAGE_BY_ID[l.stage].label, STATUS[l.status].label,
    l.status === 'lost' ? reasonLabel(l.lostReason) : '', l.createdAt.slice(0, 10), l.nextAt || '', l.attempts || 0, l.notes,
  ].map(cell).join(','));
  downloadText(`ribak-leads-${new Date().toISOString().slice(0, 10)}.csv`, '\uFEFF' + [head.map(cell).join(','), ...lines].join('\n'), 'text/csv');
}
