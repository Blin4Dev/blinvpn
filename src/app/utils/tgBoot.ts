// старт без блокировки страницы скриптом telegram.org
// index.html: определяет запуск внутри telegram по параметрам в адресе и асинхронно грузит sdk.
// здесь: ждём sdk (не дольше 4 с); если telegram.org недоступен — минимальная замена sdk
// из параметров запуска, чтобы вход и основные действия работали.

type Boot = { inTg: boolean; initData: string; platform: string; version: string; ready: Promise<boolean> };

function boot(): Boot | null {
  return (window as unknown as { __blinTg?: Boot }).__blinTg ?? null;
}

/** initData из параметров запуска (на случай, если sdk не загрузился) */
export function launchInitData(): string {
  return boot()?.initData || "";
}

type AnyWin = Window & {
  Telegram?: { WebApp?: Record<string, unknown> };
  TelegramWebviewProxy?: { postEvent: (type: string, data: string) => void };
  external?: { notify?: (s: string) => void };
};

// протокол событий mini apps (core.telegram.org/api/web-events)
function postEvent(type: string, data: Record<string, unknown> = {}): void {
  const w = window as unknown as AnyWin;
  try {
    if (w.TelegramWebviewProxy) {
      w.TelegramWebviewProxy.postEvent(type, JSON.stringify(data));
    } else if (w.external && typeof w.external.notify === "function") {
      w.external.notify(JSON.stringify({ eventType: type, eventData: data }));
    } else if (window.parent !== window) {
      window.parent.postMessage(JSON.stringify({ eventType: type, eventData: data }), "*");
    }
  } catch { /* ignore */ }
}

function parseUser(initData: string): unknown {
  try {
    const u = new URLSearchParams(initData).get("user");
    return u ? JSON.parse(u) : undefined;
  } catch {
    return undefined;
  }
}

function makeShim(b: Boot): Record<string, unknown> {
  return {
    __blinShim: true,
    initData: b.initData,
    initDataUnsafe: { user: parseUser(b.initData) },
    platform: b.platform || "unknown",
    version: b.version || "6.0",
    colorScheme: "dark",
    isExpanded: true,
    isVersionAtLeast: () => false,
    ready: () => postEvent("web_app_ready"),
    expand: () => postEvent("web_app_expand"),
    close: () => postEvent("web_app_close"),
    onEvent: () => {},
    offEvent: () => {},
    setHeaderColor: (color: string) => postEvent("web_app_set_header_color", { color }),
    setBackgroundColor: (color: string) => postEvent("web_app_set_background_color", { color }),
    openLink: (url: string) => {
      postEvent("web_app_open_link", { url });
      if (!(window as unknown as AnyWin).TelegramWebviewProxy) window.open(url, "_blank", "noopener,noreferrer");
    },
    openTelegramLink: (url: string) => {
      try {
        const u = new URL(url);
        postEvent("web_app_open_tg_link", { path_full: u.pathname + u.search });
      } catch {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    },
  };
}

/** дождаться sdk telegram (только если открыты внутри telegram) */
export async function ensureTelegram(): Promise<void> {
  const b = boot();
  if (!b || !b.inTg) return;
  const ok = await b.ready;
  const w = window as unknown as AnyWin;
  const real = w.Telegram?.WebApp as { initData?: string } | undefined;
  if (ok && real?.initData) return;
  if (!b.initData) return;
  // sdk не загрузился (или загрузился без данных) — подставляем замену
  const shim = makeShim(b);
  (b as Boot & { shim?: unknown }).shim = shim;
  w.Telegram = { ...(w.Telegram || {}), WebApp: shim };
  console.warn("[blinvpn] telegram-web-app.js недоступен — работаем на замене sdk");
}
