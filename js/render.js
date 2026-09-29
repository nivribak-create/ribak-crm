// Keeping the screen still while it is rebuilt.
//
// Every action re-renders the whole view, which is simple and always
// correct — but naively it also throws away where you had scrolled to and
// what you were typing in, and that is what makes an app feel jumpy. So
// each render is wrapped: the scroll positions and the focused field are
// noted first and put back after, and renders that arrive in a burst are
// collapsed into one.

// The places that actually scroll. Each is found by a selector that
// survives the rebuild, since the elements themselves do not.
const SCROLLERS = [
  '.board',
  '.table-wrap--leads',
  '.callview__scroll',
];

function captureScroll(root) {
  const marks = [{ sel: null, top: window.scrollY, left: 0 }];
  if (root.scrollTop) marks.push({ self: true, top: root.scrollTop, left: root.scrollLeft });
  for (const sel of SCROLLERS) {
    const el = root.querySelector(sel);
    if (el && (el.scrollTop || el.scrollLeft)) marks.push({ sel, top: el.scrollTop, left: el.scrollLeft });
  }
  // columns scroll independently, keyed by the stage they show
  root.querySelectorAll('.col[data-stage] .col__body').forEach(body => {
    if (body.scrollTop) marks.push({ sel: `.col[data-stage="${body.closest('.col').dataset.stage}"] .col__body`, top: body.scrollTop, left: 0 });
  });
  return marks;
}

function restoreScroll(root, marks) {
  for (const m of marks) {
    if (m.self) { root.scrollTop = m.top; root.scrollLeft = m.left; continue; }
    if (!m.sel) { window.scrollTo(0, m.top); continue; }
    const el = root.querySelector(m.sel);
    if (el) { el.scrollTop = m.top; el.scrollLeft = m.left; }
  }
}

// A field is found again by whatever names it. Ours are labelled in a few
// different ways, so each is tried in turn, ending with the accessible
// name — which every input here has, because it needs one anyway.
const NAMING = [
  el => (el.dataset.f ? `[data-f="${el.dataset.f}"]` : null),
  el => (el.dataset.field ? `[data-field="${el.dataset.field}"]` : null),
  el => (el.hasAttribute('data-q') ? '[data-q]' : null),
  el => (el.id ? `#${CSS.escape(el.id)}` : null),
  el => (el.name ? `[name="${el.name}"]` : null),
  el => (el.getAttribute('aria-label') ? `[aria-label="${el.getAttribute('aria-label')}"]` : null),
];

function captureFocus(root) {
  const el = document.activeElement;
  if (!el || !root.contains(el) || !el.matches('input, textarea, select')) return null;
  let sel = null;
  for (const name of NAMING) { sel = name(el); if (sel) break; }
  if (!sel) return null;
  return { sel, start: el.selectionStart, end: el.selectionEnd, value: el.value };
}

function restoreFocus(root, mark) {
  if (!mark) return;
  const el = root.querySelector(mark.sel);
  if (!el) return;
  // the rebuild renders the value the store knows about; whatever was
  // half-typed is newer than that and wins
  if (mark.value != null && el.value !== mark.value) el.value = mark.value;
  el.focus({ preventScroll: true });
  try { if (mark.start != null) el.setSelectionRange(mark.start, mark.end); } catch { /* not a text field */ }
}

// Some moments must not be interrupted: a card mid-drag would be yanked out
// of your hand, and the call script covers the view anyway.
const busy = () =>
  document.body.classList.contains('is-dragging-card') ||
  document.body.classList.contains('has-script');

let queued = null;
let queuedRoot = null;
let frame = null;

function flush() {
  frame = null;
  if (busy()) return;                 // let uiIdle() come back to it
  const run = queued;
  const root = queuedRoot;
  queued = null;
  if (!run || !root) return;
  preserve(root, run);
}

export function renderInto(root, fn) {
  queued = fn;
  queuedRoot = root;
  if (frame) return;
  // A hidden tab is painted no frames at all, so waiting for one would
  // hold the render forever; there is nothing to smooth there anyway.
  if (document.hidden) { flush(); return; }
  frame = requestAnimationFrame(flush);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && queued) flush(); });

// Rebuilding something smaller than a whole view — the lead drawer — with
// the same protection, straight away rather than on the next frame.
export function preserve(root, fn) {
  const scroll = captureScroll(root);
  const focus = captureFocus(root);
  fn();
  restoreScroll(root, scroll);
  restoreFocus(root, focus);
}

// Called when a drag ends or the call script closes, to let through
// whatever was held back.
export function uiIdle(root) {
  if (!queued || frame) return;
  renderInto(root, queued);
}

export const hasQueuedRender = () => Boolean(queued);
