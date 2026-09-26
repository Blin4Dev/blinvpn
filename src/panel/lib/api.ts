

declare const importMeta: any | undefined;

export const rawEnv: any =
  (typeof importMeta !== 'undefined' && importMeta.env) ||
  (typeof (window as any) !== 'undefined' && (window as any).__ENV__) ||
  {};

export const BOT_USERNAME: string = rawEnv.VITE_BOT_USERNAME || rawEnv.REACT_APP_BOT_USERNAME || 'blinvpn_bot';

export function getPanelToken(): string {
  return typeof window !== 'undefined' ? localStorage.getItem('panel_token') || '' : '';
}

export function setPanelToken(token: string): void {
  if (typeof window !== 'undefined') localStorage.setItem('panel_token', token);
}

export function clearPanelToken(): void {
  if (typeof window !== 'undefined') localStorage.removeItem('panel_token');
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<any> {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const url = `/api${cleanPath}`;
  const headers: any = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (cleanPath.startsWith('/panel')) {
    const token = getPanelToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    if (res.status === 401) {
      clearPanelToken();
      window.location.reload();
    }
    const text = await res.text();
    throw new Error(text || `Request failed with status ${res.status}`);
  }
  try { return await res.json(); } catch { return null; }
}

export const parseApiErr = (e: any, fb: string) => {
  try { const p = JSON.parse(e?.message || ''); return p?.detail?.message || p?.error || (typeof p?.detail === 'string' ? p.detail : '') || fb; } catch { return fb; }
};

export const copyToClipboard = async (text: string) => {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    try {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
    } catch { return false; }
  }
};

export const parseErr = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  try {
    const j = JSON.parse(msg);
    const d = j.detail;
    if (d && typeof d === 'object') return d.message || j.error || msg;
    return d || j.error || msg;
  } catch { return msg; }
};

/** Данные предупреждения об объединении аккаунтов из ответа 409 (или null). */
export const mergeInfo = (e: unknown): { message: string; merge: any } | null => {
  const msg = e instanceof Error ? e.message : String(e);
  try {
    const j = JSON.parse(msg);
    if (j?.detail?.merge) return { message: j.detail.message, merge: j.detail.merge };
  } catch { /* не JSON */ }
  return null;
};
