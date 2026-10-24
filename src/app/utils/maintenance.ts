// режим техработ: включён в панели ("manual") или edge жив, а панель не отвечает ("down").
// Пока режим активен, App показывает только страницу техработ — остальное дерево не монтируется.
import { useEffect, useState } from "react";

export type MaintState = "unknown" | "ok" | "manual" | "down";

const CHANNEL_KEY = "blinvpn_channel_url";
export const DEFAULT_CHANNEL_URL = "https://t.me/blinvpn";

let state: MaintState = "unknown";
const listeners = new Set<(s: MaintState) => void>();
let inflight: Promise<MaintState> | null = null;

function setState(next: MaintState) {
  // ok/unknown → техработы и обратно; повтор не будит подписчиков
  if (next === state) return;
  state = next;
  listeners.forEach((fn) => fn(state));
}

export function maintenanceState(): MaintState {
  return state;
}

export function channelUrl(): string {
  try {
    const v = localStorage.getItem(CHANNEL_KEY) || "";
    if (/^https:\/\//i.test(v)) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_CHANNEL_URL;
}

function rememberChannel(url: unknown) {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) return;
  try {
    localStorage.setItem(CHANNEL_KEY, url);
  } catch {
    /* ignore */
  }
}

/**
 * Спросить статус. Ответ ok → "ok"; флаг из панели → "manual";
 * 5xx/метка от edge или ingress → "down". Нет сети вообще (edge недоступен, нет интернета) → прежнее
 * состояние: страница техработ — только когда edge отвечает, а панель нет.
 */
export function checkMaintenance(timeoutMs = 10000): Promise<MaintState> {
  if (inflight) return inflight;
  inflight = (async () => {
    const ctrl = new AbortController();
    const t = window.setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch("/api/app/status", { cache: "no-store", signal: ctrl.signal });
      const body = (await res.json().catch(() => null)) as { maintenance?: unknown; channel_url?: unknown } | null;
      let next: MaintState;
      if (res.ok && body && body.maintenance === false) {
        rememberChannel(body.channel_url);
        next = "ok";
      } else if (body && (body.maintenance === true || body.maintenance === "manual")) {
        rememberChannel(body.channel_url);
        next = "manual";
      } else if (res.status >= 500 || (body && body.maintenance === "down")) {
        next = "down";
      } else {
        // 404/429 и т.п. — не повод закрывать приложение
        next = state === "unknown" ? "ok" : state;
      }
      setState(next);
      return next;
    } catch {
      // edge сам отвечает за ≤6 с (таймауты nginx), даже если панель молчит. Нет ответа вовсе —
      // это сеть пользователя или сам edge: страницу техработ не показываем и не снимаем
      return state;
    } finally {
      window.clearTimeout(t);
      inflight = null;
    }
  })();
  return inflight;
}

/** любой ответ api с меткой maintenance: ручной режим — сразу, «панель не отвечает» — после проверки статуса */
export function reportMaintenanceSignal(kind: unknown) {
  if (kind === "manual") {
    setState("manual");
    return;
  }
  if (kind === "down" && state !== "down" && state !== "manual") void checkMaintenance();
}

export function useMaintenance(): MaintState {
  const [s, setS] = useState<MaintState>(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
