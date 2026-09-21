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
        background: "rgba(8, 6, 4, 0.72)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        fontFamily: T.font,
        padding: 16,
        boxSizing: "border-box",
        animation: "blinvpnFadeIn 0.2s ease both",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 420,
          background: T.surface,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 28,
          padding: "26px 24px 22px",
          boxSizing: "border-box",
          position: "relative",
          animation: "blinvpnSheetUp 0.34s var(--ease-out) both",
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
            top: 18,
            right: 18,
            width: 40,
            height: 40,
            borderRadius: "50%",
            border: `1px solid ${T.border}`,
            background: T.surfaceRaised,
            color: T.textMuted,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <MSIcon name="close" style={{ fontSize: 20, color: T.textMuted }} />
        </button>

        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 16,
            background: T.orangeSoft,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 16,
          }}
        >
          <MSIcon name="rocket_launch" style={{ color: T.orange, fontSize: 26 }} />
        </div>

        <div
          style={{
            fontWeight: 700,
            fontSize: 24,
            letterSpacing: "-0.03em",
            lineHeight: 1.2,
            color: T.text,
            maxWidth: "88%",
            marginBottom: 10,
          }}
        >
          Остался один шаг
        </div>

        <div
          style={{
            fontSize: 15,
            lineHeight: "22px",
            color: T.textMuted,
            marginBottom: 22,
            maxWidth: "94%",
          }}
        >
          Добавьте подписку в приложение и подключитесь к серверу — VPN заработает меньше чем за минуту.
        </div>

        <Btn onClick={onContinue}>
          Продолжить настройку
          <MSIcon name="arrow_forward" style={{ fontSize: 20 }} />
        </Btn>
      </div>
    </div>
  );
}
