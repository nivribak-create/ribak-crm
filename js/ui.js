// Small UI primitives: modal, toast, tooltip, confirm.
import { esc } from './util.js';

// ---- modal ------------------------------------------------------------
let openCount = 0;

export function openModal({ title, body, footer = '', wide = false, onClose } = {}) {
  const root = document.createElement('div');
  root.className = 'modal-root';
  root.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal ${wide ? 'modal--wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title || '')}">
      ${title ? `<header class="modal__head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="סגירה">✕</button></header>` : ''}
      <div class="modal__body">${body}</div>
      ${footer ? `<footer class="modal__foot">${footer}</footer>` : ''}
    </div>`;
  document.body.appendChild(root);
  openCount++;
  document.body.classList.add('has-modal');

  const close = () => {
    if (!root.isConnected) return;
    root.classList.add('is-closing');
    setTimeout(() => { root.remove(); openCount--; if (!openCount) document.body.classList.remove('has-modal'); onClose?.(); }, 120);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  root.querySelector('.modal-backdrop').addEventListener('click', close);
  root.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));

  requestAnimationFrame(() => root.classList.add('is-open'));
  const first = root.querySelector('input, select, textarea, button:not([data-close])');
  first?.focus();
  return { root, close, el: root.querySelector('.modal') };
}

export function confirmDialog({ title, text, okLabel = 'אישור', danger = false }) {
  return new Promise(resolve => {
    const m = openModal({
      title,
      body: `<p class="modal__text">${esc(text)}</p>`,
      footer: `<button class="btn" data-close>ביטול</button><button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-ok>${esc(okLabel)}</button>`,
      onClose: () => resolve(false),
    });
    m.el.querySelector('[data-ok]').addEventListener('click', () => { resolve(true); m.close(); });
  });
}

// ---- toast --------------------------------------------------------------
let toastHost;
export function toast(msg, kind = '') {
  if (!toastHost) { toastHost = document.createElement('div'); toastHost.className = 'toast-host'; document.body.appendChild(toastHost); }
  const t = document.createElement('div');
  t.className = `toast ${kind ? 'toast--' + kind : ''}`;
  t.textContent = msg;
  toastHost.appendChild(t);
  requestAnimationFrame(() => t.classList.add('is-in'));
  setTimeout(() => { t.classList.remove('is-in'); setTimeout(() => t.remove(), 200); }, 2600);
}

// ---- tooltip (one floating element, driven by data-tip) -----------------
let tip;
function ensureTip() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  return tip;
}
function place(x, y) {
  const el = ensureTip();
  const pad = 12, vw = window.innerWidth, vh = window.innerHeight;
  const r = el.getBoundingClientRect();
  let left = x + pad, top = y + pad;
  if (left + r.width > vw - 8) left = x - r.width - pad;
  if (top + r.height > vh - 8) top = y - r.height - pad;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}
export function installTooltips(root = document) {
  root.addEventListener('mouseover', e => {
    const t = e.target.closest('[data-tip]');
    if (!t) return;
    const el = ensureTip();
    el.innerHTML = t.dataset.tip;
    el.classList.add('is-on');
    place(e.clientX, e.clientY);
  });
  root.addEventListener('mousemove', e => {
    if (!tip || !tip.classList.contains('is-on')) return;
    if (!e.target.closest('[data-tip]')) { tip.classList.remove('is-on'); return; }
    place(e.clientX, e.clientY);
  });
  root.addEventListener('mouseout', e => {
    if (!tip) return;
    const t = e.target.closest('[data-tip]');
    if (t && !t.contains(e.relatedTarget)) tip.classList.remove('is-on');
  });
}

// ---- form helpers -------------------------------------------------------
export const field = (label, control, hint = '') => `
  <label class="field">
    <span class="field__label">${esc(label)}</span>
    ${control}
    ${hint ? `<span class="field__hint">${esc(hint)}</span>` : ''}
  </label>`;

export const select = (name, options, value = '', { placeholder = '' } = {}) => `
  <select name="${esc(name)}" class="input">
    ${placeholder ? `<option value="">${esc(placeholder)}</option>` : ''}
    ${options.map(o => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`;
    }).join('')}
  </select>`;

export function formData(form) {
  const out = {};
  new FormData(form).forEach((v, k) => { out[k] = typeof v === 'string' ? v.trim() : v; });
  return out;
}
