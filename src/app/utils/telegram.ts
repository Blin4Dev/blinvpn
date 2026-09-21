/**
 * Инициализация Telegram WebApp viewport.
 *
 *   • Телефоны (android/ios) → полноэкранный режим requestFullscreen (Bot API 8.0+),
 *     с откатом на expand(), если клиент не поддерживает fullscreen.
 *   • Компьютеры (Telegram Desktop / web) → expand() на всю доступную высоту (fullsize).
 *
 * Безопасно вызывать вне Telegram — тогда просто ничего не делает.
 */

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

/** В Telegram (не в браузере)? */
export function isTelegramClient(): boolean {
  const tg = webApp();
  return Boolean(tg?.initData && tg.initData.length > 0);
}

/**
 * Верхний отступ только для Telegram fullscreen:
 * кнопки закрытия/свернуть перекрывают контент. В браузере — 0.
 */
export function applyTelegramTopInset(): void {
  try {
    const tg = webApp();
    if (!tg?.initData) {
      document.documentElement.style.setProperty("--blin-tg-pad-top", "0px");
      return;
    }
    const platform = String(tg.platform || "").toLowerCase();
    const isMobile = MOBILE_PLATFORMS.has(platform);
    // Отступ нужен в fullscreen / на мобиле; в браузере и TG Desktop без fullscreen — 0.
    if (!isMobile && !tg.isFullscreen) {
      document.documentElement.style.setProperty("--blin-tg-pad-top", "0px");
      return;
    }
    const safe = Number(tg.safeAreaInset?.top) || 0;
    const content = Number(tg.contentSafeAreaInset?.top) || 0;
    // contentSafeArea — зона под кнопками TG; если API ещё не отдал — небольшой fallback.
    const top = Math.max(safe + content, content, 52);
    document.documentElement.style.setProperty("--blin-tg-pad-top", `${Math.round(top)}px`);
  } catch {
    document.documentElement.style.setProperty("--blin-tg-pad-top", "0px");
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

/** Данные пользователя из Telegram WebApp (initDataUnsafe.user), либо null. */
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

/**
 * Вписывает фиксированный макет (ширина 402px) в реальную ширину экрана:
 * выставляет CSS-переменную --blin-scale = min(1, ширина/402). Весь #root
 * масштабируется по ней (см. global.css) — ничего не «уезжает» и не скроллится
 * вбок, кнопки попадают точно. Пересчитывается при повороте/ресайзе.
 */
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
  // Вне Telegram — отступ не нужен (браузер).
  if (!tg?.initData) {
    applyTelegramTopInset();
    return;
  }

  try { tg.ready?.(); } catch { /* noop */ }
  try { tg.expand?.(); } catch { /* noop */ }

  // Цвета шапки/фона под тёплую тему приложения.
  try { tg.setBackgroundColor?.("#14110E"); } catch { /* noop */ }
  try { tg.setHeaderColor?.("#14110E"); } catch { /* noop */ }

  applyTelegramTopInset();
  try { tg.onEvent?.("safeAreaChanged", applyTelegramTopInset); } catch { /* noop */ }
  try { tg.onEvent?.("contentSafeAreaChanged", applyTelegramTopInset); } catch { /* noop */ }
  try { tg.onEvent?.("fullscreenChanged", applyTelegramTopInset); } catch { /* noop */ }

  const platform = String(tg.platform || "").toLowerCase();
  const isMobile = MOBILE_PLATFORMS.has(platform);
  if (isMobile) {
    // Полноэкранный режим на телефоне (Bot API 8.0+).
    // Верхний отступ под кнопки TG — через --blin-tg-pad-top (только Telegram).
    const canFullscreen =
      typeof tg.requestFullscreen === "function" &&
      (typeof tg.isVersionAtLeast !== "function" || tg.isVersionAtLeast("8.0"));
    if (canFullscreen) {
      try { tg.onEvent?.("fullscreenFailed", () => { try { tg.expand?.(); } catch { /* noop */ } }); } catch { /* noop */ }
      try { if (!tg.isFullscreen) tg.requestFullscreen?.(); } catch { try { tg.expand?.(); } catch { /* noop */ } }
    }
    try { tg.disableVerticalSwipes?.(); } catch { /* noop */ }
  }
}
