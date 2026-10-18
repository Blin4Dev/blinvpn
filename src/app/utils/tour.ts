// флаг «инструкцию на главной уже показали»
// telegram CloudStorage (переживает переустановку и другие устройства) + localStorage как запасной
const KEY = "blin_home_tour_v1";

type CloudStorage = {
  getItem?: (key: string, cb: (err: unknown, value?: string) => void) => void;
  setItem?: (key: string, value: string, cb?: (err: unknown, ok?: boolean) => void) => void;
};

function cloud(): CloudStorage | null {
  try {
    const wa = (window as unknown as {
      Telegram?: { WebApp?: { initData?: string; CloudStorage?: CloudStorage; isVersionAtLeast?: (v: string) => boolean } };
    }).Telegram?.WebApp;
    if (!wa?.initData || !wa.CloudStorage?.getItem) return null;
    if (wa.isVersionAtLeast && !wa.isVersionAtLeast("6.9")) return null;
    return wa.CloudStorage;
  } catch {
    return null;
  }
}

function localSeen(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function isHomeTourSeen(): Promise<boolean> {
  if (localSeen()) return Promise.resolve(true);
  const cs = cloud();
  if (!cs?.getItem) return Promise.resolve(false);
  return new Promise((resolve) => {
    // не ждём облако дольше 1.5 с — лучше показать лишний раз, чем зависнуть
    const t = window.setTimeout(() => resolve(false), 1500);
    try {
      cs.getItem!(KEY, (err, value) => {
        window.clearTimeout(t);
        resolve(!err && value === "1");
      });
    } catch {
      window.clearTimeout(t);
      resolve(false);
    }
  });
}

export function markHomeTourSeen(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch { /* ignore */ }
  try {
    cloud()?.setItem?.(KEY, "1");
  } catch { /* ignore */ }
}
