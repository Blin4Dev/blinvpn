import React from "react";
import { Btn, MSIcon, T, btnReset } from "./ui";

export default function SetupPrompt({
  onContinue,
  onClose,
}: {
  onContinue: () => void;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2500,
        background: "rgba(8, 6, 4, 0.7)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        fontFamily: T.font,
        padding: 0,
        boxSizing: "border-box",
        animation: "blinvpnFadeIn 0.18s ease both",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 402,
          background: T.bg,
          borderTop: `1px solid ${T.border}`,
          padding: "18px 26px 24px",
          boxSizing: "border-box",
          position: "relative",
          animation: "blinvpnSheetUp 0.28s var(--ease-out) both",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть"
          className="blin-press"
          style={{
            ...btnReset,
            position: "absolute",
            top: 16,
            right: 20,
            width: 36,
            height: 36,
            borderRadius: 10,
            border: `1px solid ${T.border}`,
            background: T.surface,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <MSIcon name="close" style={{ fontSize: 18, color: T.textMuted }} />
        </button>

        <div style={{ fontWeight: 600, fontSize: 18, color: T.text, marginBottom: 8, maxWidth: "85%" }}>
          Остался один шаг
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.5, color: T.textMuted, marginBottom: 20 }}>
          Добавьте подписку в приложение и подключитесь к серверу — VPN заработает меньше чем за минуту.
        </div>

        <Btn onClick={onContinue}>Продолжить настройку</Btn>
      </div>
    </div>
  );
}
