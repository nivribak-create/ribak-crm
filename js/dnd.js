// Dragging cards between columns.
//
// Pointer events rather than HTML5 drag and drop, because the board is used
// on a phone as much as on a desktop and HTML5 drag never fires on touch.
// A mouse starts dragging once the pointer has moved a few pixels; a finger
// has to hold still for a moment first, so scrolling a column still works.
//
// Smoothness comes from doing almost nothing per pointer event: the move
// handler only records where the pointer is, and a single animation frame
// does the drawing. Which column the pointer is over is worked out from
// numbers measured once at the start of the drag, never by asking the
// browser what is under the cursor — that question forces a full layout
// recalculation, and asking it sixty times a second is what makes a drag
// feel like it is catching on something.

const MOVE_THRESHOLD = 6;
const TOUCH_HOLD_MS = 240;
const EDGE = 80;            // distance from the board edge that auto-scrolls
const EDGE_SPEED = 14;      // pixels per frame at the very edge

let board = null;
let onDrop = null;
let cardSelector = '.card';
let columnSelector = '.col';
let wired = false;

let drag = null;
let holdTimer = null;
let suppressClick = false;
let frame = null;

export function installDrag(el, opts) {
  board = el;
  onDrop = opts.onDrop;
  cardSelector = opts.cardSelector || '.card';
  columnSelector = opts.columnSelector || '.col';
  if (!wired) { wire(); wired = true; }
}

// Columns are laid out inside the board, so their offsets hold still even
// while it scrolls — only the scroll offset has to be added back.
function measure() {
  const rect = board.getBoundingClientRect();
  const columns = [...board.querySelectorAll(columnSelector)].map(el => ({
    el,
    stage: el.dataset.stage,
    left: el.offsetLeft,
    right: el.offsetLeft + el.offsetWidth,
  }));
  return { rect, columns };
}

function columnAt(x, y) {
  const { rect, columns } = drag.geom;
  if (y < rect.top || y > rect.bottom) return null;
  const local = x - rect.left + board.scrollLeft;
  return columns.find(c => local >= c.left && local < c.right) || null;
}

function begin(e) {
  drag.active = true;
  drag.geom = measure();

  const r = drag.card.getBoundingClientRect();
  drag.offX = drag.x - r.left;
  drag.offY = drag.y - r.top;

  const ghost = drag.card.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.classList.remove('is-dragging');
  ghost.style.width = `${r.width}px`;
  ghost.style.height = `${r.height}px`;
  document.body.appendChild(ghost);
  drag.ghost = ghost;

  drag.card.classList.add('is-dragging');
  board.classList.add('is-dnd');
  document.body.classList.add('is-dragging-card');
  if (navigator.vibrate) navigator.vibrate(8);

  frame = requestAnimationFrame(tick);
}

// One frame does all the work: move the ghost, scroll the board if the
// pointer is near an edge, and light up whichever column it is over.
function tick() {
  if (!drag?.active) { frame = null; return; }
  const { x, y } = drag;

  drag.ghost.style.transform = `translate3d(${x - drag.offX}px, ${y - drag.offY}px, 0) rotate(-1.5deg)`;

  const { rect } = drag.geom;
  let speed = 0;
  if (x < rect.left + EDGE) speed = -EDGE_SPEED * (1 - (x - rect.left) / EDGE);
  else if (x > rect.right - EDGE) speed = EDGE_SPEED * (1 - (rect.right - x) / EDGE);
  if (speed) board.scrollLeft += speed;

  const col = columnAt(x, y);
  if (col?.el !== drag.overEl) {
    drag.overEl?.classList.remove('is-drop-target');
    drag.overEl = col && col.el !== drag.fromEl ? col.el : null;
    drag.overEl?.classList.add('is-drop-target');
    drag.overStage = drag.overEl ? col.stage : null;
  }

  frame = requestAnimationFrame(tick);
}

function cleanup() {
  clearTimeout(holdTimer);
  if (frame) { cancelAnimationFrame(frame); frame = null; }
  drag?.ghost?.remove();
  drag?.card.classList.remove('is-dragging');
  drag?.overEl?.classList.remove('is-drop-target');
  board?.classList.remove('is-dnd');
  document.body.classList.remove('is-dragging-card');
  drag = null;
}

function wire() {
  document.addEventListener('pointerdown', e => {
    if (!board?.isConnected || !board.contains(e.target)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const card = e.target.closest(cardSelector);
    if (!card || e.target.closest('button, a, input, textarea, select, label')) return;
    drag = {
      card, id: card.dataset.id, fromEl: card.closest(columnSelector),
      x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY,
      active: false, touch: e.pointerType !== 'mouse', overEl: null, overStage: null,
    };
    if (drag.touch) holdTimer = setTimeout(() => { if (drag && !drag.active) begin(e); }, TOUCH_HOLD_MS);
  });

  document.addEventListener('pointermove', e => {
    if (!drag) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.active) { e.preventDefault(); return; }
    const moved = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0);
    // on touch, moving before the hold completes means they meant to scroll
    if (drag.touch) { if (moved > MOVE_THRESHOLD) cleanup(); return; }
    if (moved >= MOVE_THRESHOLD) begin(e);
  }, { passive: false });

  document.addEventListener('pointerup', () => {
    if (!drag) return;
    if (!drag.active) { cleanup(); return; }
    const { id, overStage, overEl, card } = drag;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 80);

    // Put the card where it was dropped straight away, so the move is seen
    // at once rather than after the board has been rebuilt from the store.
    if (overStage && overEl) {
      const body = overEl.querySelector('.col__body') || overEl;
      body.appendChild(card);
      card.classList.add('just-dropped');
    }
    cleanup();
    if (overStage) onDrop(id, overStage);
  });

  document.addEventListener('pointercancel', cleanup);

  // a drag that ended on a card must not also count as a tap on it
  document.addEventListener('click', e => {
    if (!suppressClick) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}
