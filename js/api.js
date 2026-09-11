// Thin client for the server API. Every call is same-origin; when there is
// no server (GitHub Pages, a static host, opening the folder) `probe()`
// resolves null and the app runs in local mode.
const BASE = 'api';

async function req(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* non-JSON */ }
  if (!r.ok) {
    const e = new Error((data && (data.message || data.error)) || `HTTP ${r.status}`);
    e.status = r.status;
    e.code = (data && data.code) || `http_${r.status}`;
    throw e;
  }
  return data;
}

export async function probe() {
  try {
    const r = await fetch(`${BASE}/session`, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.mode === 'remote' ? d : null;
  } catch { return null; }
}

export const login = password => req('POST', '/login', { password });
export const logout = () => req('POST', '/logout', {});
export const fetchAll = () => req('GET', '/leads');
export const saveLead = lead => req('PUT', `/leads/${encodeURIComponent(lead.id)}`, lead);
export const removeLead = id => req('DELETE', `/leads/${encodeURIComponent(id)}`);
export const replaceLeads = leads => req('PUT', '/leads', { leads });
export const saveSettings = settings => req('PUT', '/settings', settings);
