import * as store from './store.js';
import { generateSample } from './sample.js';
import { openLeadForm, openDrawer, closeDrawer } from './lead.js';
import { installTooltips, toast, confirmDialog, openModal } from './ui.js';
import { downloadText, fmtNum, esc } from './util.js';
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
  const state = store.getState();
  if (!state.ready) return;
  if (isLocked(state)) { renderGate(state); return; }
  const h = location.hash.replace(/^#\/?/, '');
  const [seg, id] = h.split('/');
  if (seg === 'lead' && id) {
    if (!current) show(sessionStorage.getItem('ribak:view') || 'pipeline');
    openDrawer(id);
    return;
  }
  show(VIEWS[seg] ? seg : 'dashboard');
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

// ---- gate: login / setup screens (remote mode only) ---------------------
const isLocked = s => s.mode === 'remote' && (!s.configured || !s.dbOk || !s.auth);

function renderGate(state) {
  current = null;
  closeDrawer();
  document.body.classList.add('is-locked');
  main.className = 'view view--gate';
  if (!state.configured || !state.dbOk) {
    const missing = state.missing || [];
    main.innerHTML = `
      <div class="gate">
        <div class="gate__card">
          <h1 class="gate__title">השרת עוד לא מחובר</h1>
          ${!state.configured
            ? `<p class="gate__text">חסרות הגדרות בשרת. ב‑Hostinger, תחת <b>Environment variables</b>, צריך להגדיר:</p>
               <ul class="gate__list">${missing.map(k => `<li><code>${esc(k)}</code></li>`).join('')}</ul>`
            : `<p class="gate__text">ההגדרות קיימות, אבל החיבור לדאטהבייס נכשל:</p>
               <p class="gate__err"><code>${esc(state.dbError || 'unknown')}</code></p>
               <p class="gate__text">בדוק את <code>DB_HOST</code>, <code>DB_NAME</code>, <code>DB_USER</code> ו‑<code>DB_PASSWORD</code> ב‑Environment variables.</p>`}
          <button class="btn btn--primary" data-gate="retry">בדוק שוב</button>
        </div>
      </div>`;
    main.querySelector('[data-gate="retry"]').addEventListener('click', () => location.reload());
    return;
  }
  main.innerHTML = `
    <div class="gate">
      <form class="gate__card" id="login-form">
        <h1 class="gate__title">כניסה ל‑Ribak CRM</h1>
        <p class="gate__text">הלידים משותפים לכל מי שנכנס עם הסיסמה.</p>
        <label class="field">
          <span class="field__label">סיסמה</span>
          <input class="input" type="password" name="password" autocomplete="current-password" required autofocus>
        </label>
        <p class="gate__err" data-err hidden></p>
        <button class="btn btn--primary" type="submit">כניסה</button>
      </form>
    </div>`;
  const form = main.querySelector('#login-form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button'); const err = form.querySelector('[data-err]');
    btn.disabled = true; err.hidden = true;
    try {
      await store.login(form.password.value);
      await offerMigration();
      document.body.classList.remove('is-locked');
      route();
    } catch (ex) {
      err.textContent = ex.code === 'wrong_password' ? 'סיסמה שגויה' : ex.code === 'too_many_attempts' ? 'יותר מדי ניסיונות – נסה שוב בעוד רבע שעה' : `לא הצלחתי להיכנס: ${ex.message}`;
      err.hidden = false; btn.disabled = false; form.password.select();
    }
  });
}

// First login on a device that already has leads from local mode.
async function offerMigration() {
  const state = store.getState();
  if (state.leads.length) return;
  const local = store.localLeadsForMigration();
  if (!local.length) return;
  const ok = await confirmDialog({ title: 'לידים מהמכשיר הזה', text: `נמצאו ${fmtNum(local.length)} לידים שנשמרו בדפדפן הזה לפני החיבור לדאטהבייס. להעלות אותם לדאטהבייס המשותף?`, okLabel: 'העלה לדאטהבייס' });
  if (ok) { store.replaceAll(local, { sample: false }); toast(`${fmtNum(local.length)} לידים הועלו`, 'good'); }
}

// ---- store → UI ---------------------------------------------------------
store.subscribe(state => {
  if (!state.ready) return;
  if (isLocked(state)) { if (current !== null || !main.querySelector('.gate')) renderGate(state); return; }
  document.body.classList.remove('is-locked');
  if (current) VIEWS[current].render(main, state); else route();
  updateChrome(state);
  if (state.lastError) { toast(state.lastError, 'warn'); store.clearError(); }
});

function updateChrome(state) {
  const el = document.getElementById('badge');
  const n = state.leads.filter(l => l.status === 'active').length;
  el.textContent = n ? fmtNum(n) : '';
  el.hidden = !n;
  document.getElementById('sample-banner').hidden = !state.settings.sample;
  document.getElementById('logout').hidden = state.mode !== 'remote';
  const mode = document.getElementById('mode');
  mode.hidden = state.mode !== 'local';
}

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
    case 'logout': doLogout(); break;
  }
});

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !isLocked(store.getState())) { e.preventDefault(); openLeadForm(); }
});

async function doLogout() {
  const ok = await confirmDialog({ title: 'יציאה', text: 'לצאת מהמערכת במכשיר הזה?', okLabel: 'יציאה' });
  if (ok) { await store.logout(); }
}

async function startClean() {
  const ok = await confirmDialog({ title: 'התחלה עם נתונים אמיתיים', text: 'נתוני הדוגמה יימחקו והמערכת תתחיל ריקה. להמשיך?', okLabel: 'מחק את הדוגמה' });
  if (ok) { store.clearAll(); toast('המערכת נקייה – אפשר להתחיל להזין לידים', 'good'); }
}

async function loadSample() {
  const state = store.getState();
  if (state.leads.length) {
    const ok = await confirmDialog({ title: 'טעינת נתוני דוגמה', text: `יש כבר ${fmtNum(state.leads.length)} לידים במערכת. נתוני הדוגמה יחליפו אותם${state.mode === 'remote' ? ' – אצל כולם' : ''}. להמשיך?`, okLabel: 'החלף בדוגמה', danger: true });
    if (!ok) return;
  }
  store.replaceAll(generateSample(), { sample: true });
  toast('נטענו נתוני דוגמה', 'good');
}

function openDataMenu() {
  const state = store.getState();
  const where = state.mode === 'remote' ? 'בדאטהבייס המשותף' : 'בדפדפן הזה';
  const m = openModal({
    title: 'נתונים',
    body: `
      <div class="data-menu">
        <p class="modal__text">${fmtNum(state.leads.length)} לידים שמורים ${where}${state.settings.sample ? ' <span class="tag tag--warn">נתוני דוגמה</span>' : ''}.</p>
        <button class="btn" data-x="export">⬇ ייצוא גיבוי (JSON)</button>
        <label class="btn">⬆ ייבוא גיבוי<input type="file" accept="application/json,.json" hidden data-x="import"></label>
        <button class="btn" data-x="sample">טען נתוני דוגמה</button>
        <button class="btn btn--danger-ghost" data-x="clear">מחק את כל הלידים</button>
        <p class="field__hint">${state.mode === 'remote'
          ? 'הלידים נשמרים בדאטהבייס ומשותפים לכל מי שנכנס. כדאי לייצא גיבוי מדי פעם.'
          : 'הנתונים נשמרים במכשיר הזה בלבד. ייצא גיבוי מדי פעם, או כדי להעביר למחשב אחר.'}</p>
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
      const ok = await confirmDialog({ title: 'מחיקת כל הלידים', text: `כל הלידים יימחקו ${state.mode === 'remote' ? 'מהדאטהבייס – אצל כולם' : 'מהמכשיר הזה'}. כדאי לייצא גיבוי קודם.`, okLabel: 'מחק הכל', danger: true });
      if (ok) { store.clearAll(); toast('כל הלידים נמחקו'); }
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
      store.replaceAll(list, { sample: false });
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
main.innerHTML = '<div class="empty">טוען…</div>';

(async () => {
  await store.init();
  const state = store.getState();
  // Local mode opens with example data the first time so the app isn't an empty shell.
  if (state.mode === 'local' && !state.leads.length && !localStorage.getItem('ribak:seen')) {
    store.replaceAll(generateSample(), { sample: true });
  }
  localStorage.setItem('ribak:seen', '1');
  updateChrome(store.getState());
  route();

  if (state.mode === 'remote') {
    const quiet = () => document.body.classList.contains('has-modal') || document.body.classList.contains('has-drawer');
    setInterval(() => { if (!quiet()) store.refresh(); }, 45000);
    window.addEventListener('focus', () => { if (!quiet()) store.refresh(); });
  }
})();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
