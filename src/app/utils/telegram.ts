// viewport telegram webapp: fullscreen на телефоне, expand на десктопе

type TgInset = { top?: number; bottom?: number; left?: number; right?: number };

type AnyTg = {
  platform?: string;
  version?: string;
  initData?: string;
  isFullscreen?: boolean;
  safeAreaInset?: TgInset;
  contentSafeAreaInset?: TgInset;
  ready?: () => void;
  expand?: () => void;
  requestFullscreen?: () => void;
  exitFullscreen?: () => void;
  disableVerticalSwipes?: () => void;
  isVersionAtLeast?: (v: string) => boolean;
  onEvent?: (event: string, cb: () => void) => void;
  setBackgroundColor?: (color: string) => void;
  setHeaderColor?: (color: string) => void;
};

// true внутри telegram, false в браузере
export function isTelegramClient(): boolean {
  const tg = webApp();
  return Boolean(tg?.initData && tg.initData.length > 0);
}

// верхний отступ только в tg fullscreen (иначе шапка tg уже закрывает)
export function applyTelegramTopInset(): void {
  const root = document.documentElement.style;
  try {
    const tg = webApp();
    const bottomSafe = Number(tg?.safeAreaInset?.bottom) || 0;
    const bottomContent = Number(tg?.contentSafeAreaInset?.bottom) || 0;
    // индикатор home и т.п. в любом режиме tg
    root.setProperty("--blin-tg-pad-bottom", tg?.initData ? `${Math.round(bottomSafe + bottomContent)}px` : "0px");

    if (!tg?.initData || !tg.isFullscreen) {
      root.setProperty("--blin-tg-pad-top", "0px");
      return;
    }
    // status bar + оверлеи close/menu tg; без обоих шапка уедет под них
    const content = Number(tg.contentSafeAreaInset?.top) || 0;
    const safe = Number(tg.safeAreaInset?.top) || 0;
    const top = content + safe > 0 ? content + safe + 8 : 92;
    root.setProperty("--blin-tg-pad-top", `${Math.round(top)}px`);
  } catch {
    root.setProperty("--blin-tg-pad-top", "0px");
    root.setProperty("--blin-tg-pad-bottom", "0px");
  }
}

const MOBILE_PLATFORMS = new Set(["android", "android_x", "ios"]);

function webApp(): AnyTg | null {
  try {
    return (window as unknown as { Telegram?: { WebApp?: AnyTg } }).Telegram?.WebApp ?? null;
  } catch {
    return null;
  }
}

export type TgUser = {
  id?: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
};

export function tgUser(): TgUser | null {
  try {
    const wa = (window as unknown as {
      Telegram?: { WebApp?: { initDataUnsafe?: { user?: TgUser } } };
    }).Telegram?.WebApp;
    return wa?.initDataUnsafe?.user ?? null;
  } catch {
    return null;
  }
}

// --blin-scale = min(1, width/402); см. global.css
const DESIGN_WIDTH = 402;

export function applyStageScale(): void {
  try {
    const w = window.visualViewport?.width || window.innerWidth || DESIGN_WIDTH;
    const scale = Math.min(1, w / DESIGN_WIDTH);
    document.documentElement.style.setProperty("--blin-scale", String(scale));
  } catch { /* noop */ }
}

export function initStageScale(): void {
  applyStageScale();
  try {
    window.addEventListener("resize", applyStageScale);
    window.addEventListener("orientationchange", applyStageScale);
    window.visualViewport?.addEventListener("resize", applyStageScale);
  } catch { /* noop */ }
}

export function initTelegramViewport(): void {
  const tg = webApp();
  if (!tg?.initData) {
    applyTelegramTopInset();
    return;
  }

  try { tg.ready?.(); } catch { /* noop */ }
  try { tg.expand?.(); } catch { /* noop */ }

  try { tg.setBackgroundColor?.("#14110E"); } catch { /* noop */ }
  try { tg.setHeaderColor?.("#14110E"); } catch { /* noop */ }

  applyTelegramTopInset();
  try { tg.onEvent?.("safeAreaChanged", applyTelegramTopInset); } catch { /* noop */ }
  try { tg.onEvent?.("contentSafeAreaChanged", applyTelegramTopInset); } catch { /* noop */ }
  try { tg.onEvent?.("fullscreenChanged", applyTelegramTopInset); } catch { /* noop */ }

  const platform = String(tg.platform || "").toLowerCase();
  const isMobile = MOBILE_PLATFORMS.has(platform);
  if (isMobile) {
    // requestFullscreen на телефоне (bot api 8.0+); отступ через --blin-tg-pad-top
    const canFullscreen =
      typeof tg.requestFullscreen === "function" &&
      (typeof tg.isVersionAtLeast !== "function" || tg.isVersionAtLeast("8.0"));
    if (canFullscreen) {
      try { tg.onEvent?.("fullscreenFailed", () => { try { tg.expand?.(); } catch { /* noop */ } applyTelegramTopInset(); }); } catch { /* noop */ }
      try { if (!tg.isFullscreen) tg.requestFullscreen?.(); } catch { try { tg.expand?.(); } catch { /* noop */ } }
      // insets приходят после перехода в fullscreen
      window.setTimeout(applyTelegramTopInset, 50);
      window.setTimeout(applyTelegramTopInset, 300);
    }
    try { tg.disableVerticalSwipes?.(); } catch { /* noop */ }
  }
}
