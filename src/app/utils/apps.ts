/** Приложения для подключения подписки: названия, иконки, ссылки на установку. */

export type DeviceKind = "android" | "ios" | "windows" | "macos" | "linux" | "android_tv";
export type AppKind = "incy" | "happ" | "other";

export const DEVICE_TITLE: Record<DeviceKind, string> = {
  android: "Android",
  ios: "iOS",
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  android_tv: "Android TV",
};

const HAPP_INSTALL: Record<DeviceKind, string> = {
  android: "https://play.google.com/store/apps/details?id=com.happproxy&hl=ru",
  ios: "https://apps.apple.com/ru/app/happ-proxy-utility-plus/id6746188973",
  windows: "https://github.com/Happ-proxy/happ-desktop/releases/latest/download/setup-Happ.x64.exe",
  macos: "https://apps.apple.com/ru/app/happ-proxy-utility-plus/id6746188973",
  linux: "https://github.com/Happ-proxy/happ-desktop/releases/latest/",
  android_tv: "https://play.google.com/store/apps/details?id=com.happproxy",
};

const INCY_INSTALL: Record<DeviceKind, string> = {
  android: "https://play.google.com/store/apps/details?id=llc.itdev.incy",
  ios: "https://apps.apple.com/ru/app/incy/id6756943388",
  windows: "https://github.com/INCY-DEV/incy-platforms/releases/latest/download/incy-windows-setup.exe",
  macos: "https://apps.apple.com/ru/app/incy/id6756943388",
  linux: "https://github.com/INCY-DEV/incy-platforms/releases/latest/download/incy-linux-x64.deb",
  android_tv: "https://play.google.com/store/apps/details?id=llc.itdev.incy",
};

export const APP_META: Record<AppKind, { title: string; sub: string; img?: string; icon?: string; recommended?: boolean }> = {
  incy: { title: "Incy", sub: "Рекомендуем", img: "/assets/incy.png", recommended: true },
  happ: { title: "Happ", sub: "Популярное", img: "/assets/happ.png" },
  other: { title: "Другое приложение", sub: "Ссылка на подписку", icon: "link" },
};

export function detectDeviceKind(): DeviceKind {
  if (typeof navigator === "undefined") return "linux";
  const ua = navigator.userAgent || "";
  if (/Android/i.test(ua) && /TV|AFT|BRAVIA|GoogleTV/i.test(ua)) return "android_tv";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Win/i.test(ua)) return "windows";
  if (/Mac/i.test(ua)) return "macos";
  return "linux";
}

export function installUrl(app: AppKind, device: DeviceKind): string | null {
  if (app === "happ") return HAPP_INSTALL[device];
  if (app === "incy") return INCY_INSTALL[device];
  return null;
}

