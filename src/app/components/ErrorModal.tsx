import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { fetchConfig, openSupportWithError } from "../utils/api";
import { Btn, T, btnReset } from "./ui";

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
      } catch { /* дефолт */ }
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
            background: "rgba(8, 6, 4, 0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            fontFamily: T.font,
            padding: 24,
            boxSizing: "border-box",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 340,
              background: T.bg,
              border: `1px solid ${T.border}`,
              borderRadius: T.radius.lg,
              padding: "22px 20px 16px",
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 17, color: T.text }}>
              Что-то пошло не так
            </div>
            <div
              style={{
                fontSize: 14,
                lineHeight: "20px",
                color: T.textMuted,
                maxHeight: 120,
                overflowY: "auto",
                wordBreak: "break-word",
              }}
            >
              {msg}
            </div>
            <Btn onClick={() => openSupportWithError(msg || "", supportBase)} style={{ marginTop: 6 }}>
              Написать в поддержку
            </Btn>
            <button
              type="button"
              onClick={() => setMsg(null)}
              className="blin-press"
              style={{
                ...btnReset,
                width: "100%",
                height: 44,
                border: "none",
                background: "transparent",
                color: T.textMuted,
                fontWeight: 500,
                fontSize: 14,
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
