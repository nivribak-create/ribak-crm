export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const nowIso = () => new Date().toISOString();

export const dayStart = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const daysBetween = (a, b) => Math.round((dayStart(b) - dayStart(a)) / 86400000);

// yyyy-mm-dd in local time (what <input type="date"> speaks)
export const isoDay = d => {
  const x = new Date(d);
  const p = n => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
};
export const todayIso = () => isoDay(new Date());

const dShort = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short' });
const dLong  = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
const dTime  = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const nf     = new Intl.NumberFormat('he-IL');

export const fmtDate = iso => iso ? dShort.format(new Date(iso)) : '';
export const fmtDateLong = iso => iso ? dLong.format(new Date(iso)) : '';
export const fmtDateTime = iso => iso ? dTime.format(new Date(iso)) : '';
export const fmtNum = n => nf.format(n ?? 0);
export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
export const pct1 = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

export const relDays = iso => {
  if (!iso) return '';
  const d = daysBetween(iso, new Date());
  if (d <= 0) return 'היום';
  if (d === 1) return 'אתמול';
  return `לפני ${d} ימים`;
};

export const dueLabel = iso => {
  if (!iso) return '';
  const d = daysBetween(new Date(), iso);
  if (d === 0) return 'היום';
  if (d === 1) return 'מחר';
  if (d === -1) return 'אתמול';
  if (d < 0) return `באיחור ${-d} ימים`;
  return `בעוד ${d} ימים`;
};

export const normPhone = p => String(p || '').replace(/\D/g, '');
export const fmtPhone = p => {
  const d = normPhone(p);
  if (d.length === 10 && d.startsWith('05')) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return p || '';
};
export const waLink = p => {
  let d = normPhone(p);
  if (d.startsWith('0')) d = '972' + d.slice(1);
  return `https://wa.me/${d}`;
};
export const telLink = p => `tel:${normPhone(p)}`;

export const plural = (n, one, many) => (n === 1 ? one : many);

export const debounce = (fn, ms = 150) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

export const downloadText = (filename, text, type = 'text/plain') => {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
