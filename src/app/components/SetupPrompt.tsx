import React from "react";

/**
 * Онбординг-модалка «Вы не завершили настройку». Показывается при заходе в
 * мини-приложение/сайт, если у пользователя есть подписка, но он ни разу не
 * подключался к VPN. В нашем стиле, без кнопки «Больше не показывать» —
 * только крестик (закрыть на эту сессию) и основная кнопка «Продолжить настройку».
 */
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
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        fontFamily: "'Inter', sans-serif",
        padding: "16px",
        boxSizing: "border-box",
        animation: "blinvpnFadeIn 0.2s ease both",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "420px",
          background: "#1C1C1C",
          borderRadius: "28px",
          padding: "26px 24px 22px",
          boxSizing: "border-box",
          position: "relative",
          animation: "blinvpnSheetUp 0.34s cubic-bezier(0.22, 1, 0.36, 1) both",
        }}
      >
        {/* Крестик — закрыть на эту сессию */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть"
          style={{
            position: "absolute",
            top: "20px",
            right: "20px",
            width: 40,
            height: 40,
            borderRadius: "50%",
            border: "none",
            background: "#2E2E2E",
            color: "#B9B9B9",
            fontSize: 20,
            lineHeight: 1,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ✕
        </button>

        <div
          style={{
            fontWeight: 700,
            fontSize: "26px",
            lineHeight: "31px",
            color: "#FFFFFF",
            maxWidth: "80%",
            marginBottom: "12px",
          }}
        >
          Вы не завершили настройку
        </div>

        <div
          style={{
            fontSize: "15px",
            lineHeight: "21px",
            color: "#9E9E9E",
            marginBottom: "22px",
            maxWidth: "94%",
          }}
        >
          Чтобы VPN заработал, добавьте подписку в приложение и подключитесь к серверу.
          Это займёт меньше минуты.
        </div>

        <button
          type="button"
          onClick={onContinue}
          style={{
            width: "100%",
            height: "58px",
            border: "none",
            borderRadius: "20px",
            background: "#F18726",
            color: "#FFFFFF",
            fontWeight: 700,
            fontSize: "17px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
          }}
        >
          Продолжить настройку
          <span style={{ fontSize: 18, lineHeight: 1 }}>›</span>
        </button>
      </div>
    </div>
  );
}
