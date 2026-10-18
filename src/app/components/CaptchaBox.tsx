import React, { useEffect, useRef, useState } from "react";

export type CaptchaPublic = {
  enabled: boolean;
  provider?: "yandex" | "turnstile";
  siteKey?: string;
};

type Props = {
  cfg: CaptchaPublic | null;
  onToken: (token: string) => void;
  /** сброс виджета после использования токена */
  resetKey?: number;
};

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id?: string) => void;
    };
    smartCaptcha?: {
      render: (el: string | HTMLElement, opts: Record<string, unknown>) => number;
      reset: (id?: number) => void;
      destroy: (id?: number) => void;
    };
  }
}

function loadScript(src: string, id: string, onLoadAttr?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(id) as HTMLScriptElement | null;
    if (existing) {
      if ((existing as HTMLScriptElement & { dataset?: DOMStringMap }).dataset?.ready === "1") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("script")), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.id = id;
    s.src = src;
    s.async = true;
    if (onLoadAttr) s.setAttribute("onload", onLoadAttr);
    s.onload = () => {
      s.dataset.ready = "1";
      resolve();
    };
    s.onerror = () => reject(new Error("Не удалось загрузить капчу"));
    document.head.appendChild(s);
  });
}

/** виджет yandex smartcaptcha или cloudflare turnstile */
export const CaptchaBox: React.FC<Props> = ({ cfg, onToken, resetKey = 0 }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | number | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    onToken("");
    if (!cfg?.enabled || !cfg.provider || !cfg.siteKey || !hostRef.current) return;
    let cancelled = false;
    const el = hostRef.current;
    el.innerHTML = "";
    widgetId.current = null;
    setErr("");

    const run = async () => {
      try {
        if (cfg.provider === "turnstile") {
          await loadScript(
            "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
            "cf-turnstile-api",
          );
          if (cancelled || !hostRef.current || !window.turnstile) return;
          widgetId.current = window.turnstile.render(hostRef.current, {
            sitekey: cfg.siteKey,
            theme: "dark",
            callback: (t: string) => onToken(t),
            "expired-callback": () => onToken(""),
            "error-callback": () => onToken(""),
          });
        } else {
          await loadScript(
            "https://smartcaptcha.yandexcloud.net/captcha.js",
            "yandex-smartcaptcha-api",
          );
          for (let i = 0; i < 40 && !window.smartCaptcha; i++) {
            await new Promise((r) => setTimeout(r, 50));
          }
          if (cancelled || !hostRef.current || !window.smartCaptcha) {
            if (!cancelled) setErr("Капча Яндекса не загрузилась");
            return;
          }
          widgetId.current = window.smartCaptcha.render(hostRef.current, {
            sitekey: cfg.siteKey,
            hl: "ru",
            callback: (t: string) => onToken(t),
            "network-error-callback": () => onToken(""),
          });
        }
      } catch {
        if (!cancelled) setErr("Не удалось показать капчу");
      }
    };
    void run();

    return () => {
      cancelled = true;
      try {
        if (cfg.provider === "turnstile" && widgetId.current != null && window.turnstile) {
          window.turnstile.remove(String(widgetId.current));
        } else if (cfg.provider === "yandex" && widgetId.current != null && window.smartCaptcha) {
          window.smartCaptcha.destroy(Number(widgetId.current));
        }
      } catch { /* ignore */ }
      widgetId.current = null;
      el.innerHTML = "";
    };
    // resetKey специально в deps: пересоздать виджет после отправки
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg?.enabled, cfg?.provider, cfg?.siteKey, resetKey]);

  if (!cfg?.enabled || !cfg.provider || !cfg.siteKey) return null;

  return (
    <div style={{ marginTop: 16 }}>
      <div ref={hostRef} style={{ minHeight: 66, display: "flex", justifyContent: "center" }} />
      {err ? <div style={{ marginTop: 8, color: "#ef4444", fontSize: 13, textAlign: "center" }}>{err}</div> : null}
    </div>
  );
};
