// Dragging cards between columns. Pointer events rather than HTML5 drag
// and drop, because the board is used on a phone as much as on a desktop
// and HTML5 drag never fires on touch.
//
// Two ways in, matched to the device: a mouse starts dragging as soon as
// the pointer has moved a few pixels, a finger has to hold still for a
// moment first — otherwise every attempt to scroll the column would tear
// a card out of it.

const MOVE_THRESHOLD = 6;
const TOUCH_HOLD_MS = 260;
const EDGE = 70;          // how close to the board edge auto-scrolling starts

let board = null;
let onDrop = null;
let cardSelector = '.card';
let columnSelector = '.col';
let wired = false;
let drag = null;
let holdTimer = null;
let suppressClick = false;

export function installDrag(el, opts) {
  board = el;
  onDrop = opts.onDrop;
  cardSelector = opts.cardSelector || '.card';
  columnSelector = opts.columnSelector || '.col';
  if (!wired) { wire(); wired = true; }
}

function wire() {

  const cleanup = () => {
    clearTimeout(holdTimer);
    if (drag?.ghost) drag.ghost.remove();
    drag?.card.classList.remove('is-dragging');
    board.classList.remove('is-dnd');
    board.querySelectorAll('.is-drop-target').forEach(c => c.classList.remove('is-drop-target'));
    stopScroll();
    drag = null;
  };

  let scrollTimer = null;
  const stopScroll = () => { clearInterval(scrollTimer); scrollTimer = null; };
  const autoScroll = x => {
    const r = board.getBoundingClientRect();
    // the board is RTL, so "forward" is whichever edge the pointer is near
    const dir = x < r.left + EDGE ? -1 : x > r.right - EDGE ? 1 : 0;
    if (!dir) { stopScroll(); return; }
    if (scrollTimer) return;
    scrollTimer = setInterval(() => { board.scrollLeft += dir * 18; }, 16);
  };

  function begin(e) {
    drag.active = true;
    board.classList.add('is-dnd');
    drag.card.classList.add('is-dragging');

    const r = drag.card.getBoundingClientRect();
    const ghost = drag.card.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('is-dragging');
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.offX = drag.x0 - r.left;
    drag.offY = drag.y0 - r.top;
    position(e.clientX, e.clientY);
    if (navigator.vibrate) navigator.vibrate(8);
  }

  const position = (x, y) => {
    drag.ghost.style.transform = `translate(${x - drag.offX}px, ${y - drag.offY}px) rotate(-1.5deg)`;
  };

  const columnUnder = (x, y) => {
    drag.ghost.style.visibility = 'hidden';
    const el = document.elementFromPoint(x, y);
    drag.ghost.style.visibility = '';
    return el?.closest(columnSelector) || null;
  };

  document.addEventListener('pointerdown', e => {
    if (!board || !board.isConnected || !board.contains(e.target)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const card = e.target.closest(cardSelector);
    if (!card || e.target.closest('button, a, input, textarea, select, label')) return;
    drag = { card, id: card.dataset.id, x0: e.clientX, y0: e.clientY, active: false, touch: e.pointerType !== 'mouse' };
    if (drag.touch) holdTimer = setTimeout(() => { if (drag && !drag.active) begin(e); }, TOUCH_HOLD_MS);
  });

  window.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.active) {
      const moved = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0);
      // on touch, moving before the hold completes means they meant to scroll
      if (drag.touch) { if (moved > MOVE_THRESHOLD) cleanup(); return; }
      if (moved < MOVE_THRESHOLD) return;
      begin(e);
    }
    e.preventDefault();
    position(e.clientX, e.clientY);
    autoScroll(e.clientX);
    const col = columnUnder(e.clientX, e.clientY);
    board.querySelectorAll('.is-drop-target').forEach(c => { if (c !== col) c.classList.remove('is-drop-target'); });
    if (col && col.dataset.stage && col !== drag.card.closest(columnSelector)) col.classList.add('is-drop-target');
  }, { passive: false });

  window.addEventListener('pointerup', e => {
    if (!drag) return;
    if (!drag.active) { cleanup(); return; }
    const col = columnUnder(e.clientX, e.clientY);
    const from = drag.card.closest(columnSelector);
    const id = drag.id;
    const stage = col?.dataset.stage;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 60);
    cleanup();
    if (stage && col !== from) onDrop(id, stage);
  });

  window.addEventListener('pointercancel', cleanup);
  // a drag that ended on a card must not also count as a tap on it
  document.addEventListener('click', e => {
    if (!suppressClick) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}
