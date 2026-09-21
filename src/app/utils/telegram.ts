/**
 * Инициализация Telegram WebApp viewport.
 *
 *   • Телефоны (android/ios) → полноэкранный режим requestFullscreen (Bot API 8.0+),
 *     с откатом на expand(), если клиент не поддерживает fullscreen.
 *   • Компьютеры (Telegram Desktop / web) → expand() на всю доступную высоту (fullsize).
 *
 * Безопасно вызывать вне Telegram — тогда просто ничего не делает.
 */

type AnyTg = {
  platform?: string;
  version?: string;
  isFullscreen?: boolean;
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
  if (!tg) return;

  try { tg.ready?.(); } catch { /* noop */ }
  try { tg.expand?.(); } catch { /* noop */ }

  // Цвета шапки/фона под тёплую тему приложения.
  try { tg.setBackgroundColor?.("#14110E"); } catch { /* noop */ }
  try { tg.setHeaderColor?.("#14110E"); } catch { /* noop */ }

  const platform = String(tg.platform || "").toLowerCase();
  const isMobile = MOBILE_PLATFORMS.has(platform);
  if (isMobile) {
    // Полноэкранный режим на телефоне (Bot API 8.0+). «Чёлку» учитывает
    // padding-top: env(safe-area-inset-top) в global.css, поэтому контент не
    // залезает под статус-бар. Если клиент не умеет fullscreen — expand().
    const canFullscreen =
      typeof tg.requestFullscreen === "function" &&
      (typeof tg.isVersionAtLeast !== "function" || tg.isVersionAtLeast("8.0"));
    if (canFullscreen) {
      try { tg.onEvent?.("fullscreenFailed", () => { try { tg.expand?.(); } catch { /* noop */ } }); } catch { /* noop */ }
      try { if (!tg.isFullscreen) tg.requestFullscreen?.(); } catch { try { tg.expand?.(); } catch { /* noop */ } }
    }
    // Отключаем свайп-вниз, чтобы приложение не закрывалось случайно при скролле.
    try { tg.disableVerticalSwipes?.(); } catch { /* noop */ }
  }
}
