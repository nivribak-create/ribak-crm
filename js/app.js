import * as store from './store.js';
import { generateSample } from './sample.js';
import { openLeadForm, openDrawer, closeDrawer } from './lead.js';
import { installTooltips, toast, confirmDialog, openModal } from './ui.js';
import { downloadText, fmtNum } from './util.js';
import * as dashboard from './views/dashboard.js';
import * as pipeline from './views/pipeline.js';
import * as leads from './views/leads.js';

const VIEWS = {
  dashboard: { title: 'לוח בקרה', render: dashboard.render },
  pipeline:  { title: 'פייפליין',  render: pipeline.render },
  leads:     { title: 'לידים',     render: leads.render },
};

const main = document.getElementById('view');
const nav = document.getElementById('nav');
let current = null;

// ---- routing (hash) -----------------------------------------------------
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [seg, id] = h.split('/');
  if (seg === 'lead' && id) {
    if (!current) show(sessionStorage.getItem('ribak:view') || 'pipeline');
    openDrawer(id);
    return;
  }
  const view = VIEWS[seg] ? seg : 'dashboard';
  show(view);
}

function show(view) {
  current = view;
  sessionStorage.setItem('ribak:view', view);
  nav.querySelectorAll('[data-view]').forEach(a => a.classList.toggle('is-on', a.dataset.view === view));
  document.title = `${VIEWS[view].title} · Ribak CRM`;
  main.className = `view view--${view}`;
  window.scrollTo(0, 0);
  VIEWS[view].render(main, store.getState());
}

window.addEventListener('hashchange', route);
store.subscribe(state => { if (current) VIEWS[current].render(main, state); updateBadge(state); });

// ---- global controls ----------------------------------------------------
document.addEventListener('click', e => {
  const g = e.target.closest('[data-global]');
  if (!g) return;
  switch (g.dataset.global) {
    case 'add': openLeadForm(); break;
    case 'sample': loadSample(); break;
    case 'data': openDataMenu(); break;
    case 'theme': toggleTheme(); break;
    case 'start-clean': startClean(); break;
  }
});

async function startClean() {
  const ok = await confirmDialog({ title: 'התחלה עם נתונים אמיתיים', text: 'נתוני הדוגמה יימחקו והמערכת תתחיל ריקה. להמשיך?', okLabel: 'מחק את הדוגמה' });
  if (ok) { store.clearAll(); store.setSetting('sample', false); toast('המערכת נקייה – אפשר להתחיל להזין לידים', 'good'); }
}

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openLeadForm(); }
});

function updateBadge(state) {
  const el = document.getElementById('badge');
  const n = state.leads.filter(l => l.status === 'active').length;
  el.textContent = n ? fmtNum(n) : '';
  el.hidden = !n;
  document.getElementById('sample-banner').hidden = !state.settings.sample;
}

async function loadSample() {
  const state = store.getState();
  if (state.leads.length) {
    const ok = await confirmDialog({ title: 'טעינת נתוני דוגמה', text: `יש כבר ${fmtNum(state.leads.length)} לידים במערכת. נתוני הדוגמה יחליפו אותם. להמשיך?`, okLabel: 'החלף בדוגמה', danger: true });
    if (!ok) return;
  }
  store.replaceAll(generateSample());
  store.setSetting('sample', true);
  toast('נטענו נתוני דוגמה', 'good');
}

function openDataMenu() {
  const state = store.getState();
  const m = openModal({
    title: 'נתונים',
    body: `
      <div class="data-menu">
        <p class="modal__text">${fmtNum(state.leads.length)} לידים שמורים בדפדפן הזה${state.settings.sample ? ' <span class="tag tag--warn">נתוני דוגמה</span>' : ''}.</p>
        <button class="btn" data-x="export">⬇ ייצוא גיבוי (JSON)</button>
        <label class="btn">⬆ ייבוא גיבוי<input type="file" accept="application/json,.json" hidden data-x="import"></label>
        <button class="btn" data-x="sample">טען נתוני דוגמה</button>
        <button class="btn btn--danger-ghost" data-x="clear">מחק את כל הלידים</button>
        <p class="field__hint">הנתונים נשמרים במכשיר הזה בלבד. ייצא גיבוי מדי פעם, או כדי להעביר למחשב אחר.</p>
      </div>`,
  });
  m.el.addEventListener('click', async e => {
    const b = e.target.closest('[data-x]');
    if (!b || b.tagName === 'INPUT') return;
    if (b.dataset.x === 'export') {
      downloadText(`ribak-crm-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), leads: state.leads }, null, 2), 'application/json');
      toast('הגיבוי ירד למחשב');
    }
    if (b.dataset.x === 'sample') { m.close(); loadSample(); }
    if (b.dataset.x === 'clear') {
      m.close();
      const ok = await confirmDialog({ title: 'מחיקת כל הלידים', text: 'כל הלידים יימחקו מהמכשיר הזה. כדאי לייצא גיבוי קודם.', okLabel: 'מחק הכל', danger: true });
      if (ok) { store.clearAll(); store.setSetting('sample', false); toast('כל הלידים נמחקו'); }
    }
  });
  m.el.querySelector('[data-x="import"]').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data.leads;
      if (!Array.isArray(list)) throw new Error('bad');
      const ok = state.leads.length === 0 || await confirmDialog({ title: 'ייבוא גיבוי', text: `הקובץ מכיל ${fmtNum(list.length)} לידים והם יחליפו את ${fmtNum(state.leads.length)} הלידים הקיימים. להמשיך?`, okLabel: 'ייבוא', danger: true });
      if (!ok) return;
      store.replaceAll(list);
      store.setSetting('sample', false);
      toast(`יובאו ${fmtNum(list.length)} לידים`, 'good');
      m.close();
    } catch { toast('הקובץ לא תקין – צריך גיבוי שיוצא מהמערכת', 'warn'); }
  });
}

// ---- theme --------------------------------------------------------------
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme;
  const sysDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = cur ? cur === 'dark' : sysDark;
  const next = isDark ? 'light' : 'dark';
  localStorage.setItem('ribak:theme', next);
  applyTheme(next);
}
applyTheme(localStorage.getItem('ribak:theme') || '');

// ---- boot ---------------------------------------------------------------
installTooltips();
if (!store.getState().leads.length && !localStorage.getItem('ribak:seen')) {
  store.replaceAll(generateSample());
  store.setSetting('sample', true);
}
localStorage.setItem('ribak:seen', '1');
updateBadge(store.getState());
route();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
