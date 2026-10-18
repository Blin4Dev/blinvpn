export type AuthSession = {
  method?: string;
  userId?: string | number;
  email?: string;
  createdAt?: number;
};

export function getMiniAppUser(): { id?: number; username?: string } | null {
  try {
    const user = (window as unknown as { Telegram?: { WebApp?: { initDataUnsafe?: { user?: { id?: number; username?: string } } } } }).Telegram?.WebApp?.initDataUnsafe?.user;
    if (!user?.id) {
      return null;
    }
    return { id: user.id, username: user.username };
  } catch {
    return null;
  }
}

export function getStoredAuthSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem("blinvpn_auth_session");
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed || (!parsed.userId && !parsed.email && !parsed.method)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function setAuthSession(payload: AuthSession): void {
  localStorage.setItem(
    "blinvpn_auth_session",
    JSON.stringify({
      ...payload,
      createdAt: Date.now(),
    }),
  );
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней

export function isAuthenticated(): boolean {
  const session = getStoredAuthSession();
  if (!session) return false;
  if (session.createdAt && Date.now() - session.createdAt > SESSION_TTL_MS) {
    localStorage.removeItem("blinvpn_auth_session");
    return false;
  }
  return true;
}
