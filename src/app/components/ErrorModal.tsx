import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { fetchConfig, openSupportWithError } from "../utils/api";

/**
 * Единое интерфейсное окно ошибок вместо браузерного alert.
 * Показывает текст ошибки и кнопку «Написать в поддержку», в которой уже вписан
 * лог ошибки: https://t.me/blinteams?text=Здравствуйте. У меня возникла ошибка: <лог>
 */

type ErrorCtx = { showError: (message: string) => void };

const Ctx = createContext<ErrorCtx>({ showError: () => {} });

export function useAppError(): ErrorCtx {
  return useContext(Ctx);
}

export function AppErrorProvider({ children }: { children: React.ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [supportBase, setSupportBase] = useState("https://t.me/blinteams");

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await fetchConfig();
        const s = (cfg as { supportUrl?: string }).supportUrl;
        if (typeof s === "string" && s) setSupportBase(s);
      } catch {
        /* дефолт */
      }
    })();
  }, []);

  const api = useMemo<ErrorCtx>(() => ({ showError: (m: string) => setMsg(m || "Неизвестная ошибка") }), []);

  return (
    <Ctx.Provider value={api}>
      {children}
      {msg != null && (
        <div
          onClick={() => setMsg(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            fontFamily: "'Inter', sans-serif",
            padding: "24px",
            boxSizing: "border-box",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: "340px",
              background: "#2A2A2A",
              borderRadius: "24px",
              padding: "24px 22px 20px",
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "12px",
              boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
            }}
          >
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                background: "rgba(255,77,77,0.15)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 30,
              }}
            >
              ⚠️
            </div>
            <div style={{ fontWeight: 700, fontSize: "19px", color: "#FFFFFF", textAlign: "center" }}>
              Что-то пошло не так
            </div>
            <div
              style={{
                fontSize: "14px",
                lineHeight: "20px",
                color: "#C9C9C9",
                textAlign: "center",
                maxHeight: "120px",
                overflowY: "auto",
                width: "100%",
                wordBreak: "break-word",
              }}
            >
              {msg}
            </div>

            <button
              type="button"
              onClick={() => openSupportWithError(msg || "", supportBase)}
              style={{
                width: "100%",
                height: "48px",
                marginTop: "4px",
                border: "none",
                borderRadius: "16px",
                background: "#F18726",
                color: "#FFFFFF",
                fontWeight: 600,
                fontSize: "16px",
                cursor: "pointer",
              }}
            >
              Написать в поддержку
            </button>
            <button
              type="button"
              onClick={() => setMsg(null)}
              style={{
                width: "100%",
                height: "44px",
                border: "none",
                borderRadius: "16px",
                background: "transparent",
                color: "#9A9A9A",
                fontWeight: 500,
                fontSize: "15px",
                cursor: "pointer",
              }}
            >
              Закрыть
            </button>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
