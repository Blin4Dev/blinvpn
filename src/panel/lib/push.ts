import { apiFetch } from './api';

/** Push-уведомления панели (Web Push). */
export const pushSupported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;

const b64ToBytes = (b64: string) => {
  const s = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error('Браузер не поддерживает уведомления. На iPhone добавьте панель на экран «Домой».');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Уведомления запрещены в настройках браузера');
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const { key } = await apiFetch('/panel/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  try {
    await postSub(sub);
  } catch (e: any) {
    // устройство было подписано другим аккаунтом — берём новый адрес подписки
    if (!/другим аккаунтом/.test(String(e?.message))) throw e;
    await sub.unsubscribe();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    await postSub(sub);
  }
}

const postSub = (sub: PushSubscription) => {
  const j = sub.toJSON();
  return apiFetch('/panel/push/subscribe', { method: 'POST', body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }) });
};

/** При входе: подписка этого браузера принадлежит мне? Если другому аккаунту — отписываем браузер. */
export async function syncPush(): Promise<boolean> {
  const sub = await currentSubscription();
  if (!sub) return false;
  try { await postSub(sub); return true; } catch (e: any) {
    if (/другим аккаунтом/.test(String(e?.message))) { try { await sub.unsubscribe(); } catch { /* */ } }
    return false;
  }
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  try { await apiFetch('/panel/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint, keys: {} }) }); } catch { /* */ }
  await sub.unsubscribe();
}
