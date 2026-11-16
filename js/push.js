// Notifications on this device when a lead comes in. The browser shows them
// itself, with the CRM closed, so the only thing asked of the owner is one
// "allow". Each device (phone, computer) is switched on separately.
const BASE = 'api/push';

async function call(method, path = '', body) {
  const r = await fetch(`${BASE}${path}`, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null;
  try { d = await r.json(); } catch { /* non-JSON */ }
  if (!r.ok) throw new Error((d && (d.message || d.error)) || `HTTP ${r.status}`);
  return d || {};
}

const b64ToBytes = s => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isInstalled = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

// 'on' | 'off' | 'blocked' | 'ios-install' | 'unsupported'
export async function pushStatus() {
  const can = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  // An iPhone only offers notifications to a site that was added to the
  // home screen; in Safari itself the feature does not exist at all.
  if (!can) return isIos() && !isInstalled() ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}

export async function enablePush() {
  // Asked first, straight from the click: a browser refuses to show the
  // question once something slow has come between the click and the asking.
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('blocked');
  const info = await call('GET');
  if (!info.supported || !info.publicKey) throw new Error('השרת עוד לא מוכן להתראות');
  const reg = await navigator.serviceWorker.ready;
  // A subscription made for an older key cannot be reused with a new one.
  const old = await reg.pushManager.getSubscription();
  if (old) await old.unsubscribe().catch(() => {});
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(info.publicKey) });
  await call('POST', '/subscribe', { subscription: sub.toJSON() });
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await call('POST', '/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

export const testPush = () => call('POST', '/test');
