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

function supportsFullscreen(tg: AnyTg): boolean {
  try {
    if (typeof tg.requestFullscreen !== "function") return false;
    if (typeof tg.isVersionAtLeast === "function") return tg.isVersionAtLeast("8.0");
    return true;
  } catch {
    return false;
  }
}

export function initTelegramViewport(): void {
  const tg = webApp();
  if (!tg) return;

  try { tg.ready?.(); } catch { /* noop */ }
  // Разворачиваем на всю высоту — это и есть fullsize на компьютере.
  try { tg.expand?.(); } catch { /* noop */ }

  // Цвета шапки/фона под тёмную тему приложения.
  try { tg.setBackgroundColor?.("#111111"); } catch { /* noop */ }
  try { tg.setHeaderColor?.("#111111"); } catch { /* noop */ }

  const platform = String(tg.platform || "").toLowerCase();
  const isMobile = MOBILE_PLATFORMS.has(platform);

  if (isMobile && supportsFullscreen(tg)) {
    // Если fullscreen не удался (старый клиент) — откатываемся на expand().
    try { tg.onEvent?.("fullscreenFailed", () => { try { tg.expand?.(); } catch { /* noop */ } }); } catch { /* noop */ }
    try {
      if (!tg.isFullscreen) tg.requestFullscreen?.();
    } catch {
      try { tg.expand?.(); } catch { /* noop */ }
    }
    // В полноэкранном режиме отключаем свайп-вниз, чтобы не закрывать приложение случайно.
    try { tg.disableVerticalSwipes?.(); } catch { /* noop */ }
  }
}
