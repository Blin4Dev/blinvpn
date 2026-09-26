import React from "react";
import { Btn, T, btnReset } from "./ui";

/** Окно подтверждения по центру экрана (в стиле окна ошибки). */
export default function ConfirmDialog({
  title,
  children,
  confirmText,
  cancelText = "Отмена",
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: React.ReactNode;
  confirmText: string;
  cancelText?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}) {
  return (
    <div
      onClick={() => onCancel?.()}
      style={{
        position: "fixed", inset: 0, background: "rgba(8, 6, 4, 0.72)", display: "flex",
        alignItems: "center", justifyContent: "center", zIndex: 1000, fontFamily: T.font,
        padding: 24, boxSizing: "border-box",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 360, background: T.bg, border: `1px solid ${T.border}`,
          borderRadius: T.radius.lg, padding: "22px 20px 16px", boxSizing: "border-box",
          display: "flex", flexDirection: "column", gap: 12, maxHeight: "86vh", overflowY: "auto",
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 18, color: T.text }}>{title}</div>
        <div style={{ fontSize: 14, lineHeight: "20px", color: T.textMuted }}>{children}</div>
        <Btn onClick={onConfirm} disabled={busy} style={{ marginTop: 4 }}>{confirmText}</Btn>
        {onCancel && (
          <button type="button" onClick={onCancel} className="blin-press"
            style={{ ...btnReset, width: "100%", height: 44, border: "none", background: "transparent", color: T.textMuted, fontSize: 15, fontWeight: 500 }}>
            {cancelText}
          </button>
        )}
      </div>
    </div>
  );
}
