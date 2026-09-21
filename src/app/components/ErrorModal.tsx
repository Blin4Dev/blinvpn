import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { fetchConfig, openSupportWithError } from "../utils/api";
import { Btn, MSIcon, T, btnReset } from "./ui";

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
            background: "rgba(8, 6, 4, 0.72)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            fontFamily: T.font,
            padding: 24,
            boxSizing: "border-box",
            animation: "blinvpnFadeIn 0.18s ease both",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 340,
              background: T.surface,
              border: `1px solid ${T.borderStrong}`,
              borderRadius: 26,
              padding: "24px 22px 18px",
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 12,
              animation: "blinvpnSheetUp 0.3s var(--ease-out) both",
            }}
          >
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                background: T.dangerSoft,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <MSIcon name="error" style={{ color: T.danger, fontSize: 30 }} />
            </div>
            <div style={{ fontWeight: 700, fontSize: 19, color: T.text, textAlign: "center", letterSpacing: "-0.02em" }}>
              Что-то пошло не так
            </div>
            <div
              style={{
                fontSize: 14,
                lineHeight: "20px",
                color: T.textMuted,
                textAlign: "center",
                maxHeight: 120,
                overflowY: "auto",
                width: "100%",
                wordBreak: "break-word",
              }}
            >
              {msg}
            </div>

            <Btn
              onClick={() => openSupportWithError(msg || "", supportBase)}
              style={{ marginTop: 4 }}
            >
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
                borderRadius: T.radius.md,
                background: "transparent",
                color: T.textMuted,
                fontWeight: 550,
                fontSize: 15,
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
