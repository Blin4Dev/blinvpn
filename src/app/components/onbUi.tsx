import React from "react";
import { T, btnReset } from "./ui";

// общие кусочки экранов онбординга и входа

export type Haptic = {
  impactOccurred?: (s: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
  notificationOccurred?: (s: "error" | "success" | "warning") => void;
  selectionChanged?: () => void;
};
export function haptic(): Haptic | null {
  try {
    return (window as unknown as { Telegram?: { WebApp?: { HapticFeedback?: Haptic } } }).Telegram?.WebApp?.HapticFeedback ?? null;
  } catch {
    return null;
  }
}

export function Title({ children, i }: { children: React.ReactNode; i: number }) {
  return (
    <div className="blin-onb-item" style={{ ["--i" as string]: i, fontWeight: 700, fontSize: 34, lineHeight: 1.08, letterSpacing: "-0.03em", color: T.text }}>
      {children}
    </div>
  );
}

export function Sub({ children, i }: { children: React.ReactNode; i: number }) {
  return (
    <div className="blin-onb-item" style={{ ["--i" as string]: i, fontSize: 16, lineHeight: 1.45, color: T.textMuted, marginTop: 12, marginBottom: 24 }}>
      {children}
    </div>
  );
}

// как Btn primary во всём мини-аппе: плоский оранжевый, без градиента и свечения
export function PrimaryButton({ children, disabled, onClick, i }: { children: React.ReactNode; disabled?: boolean; onClick: () => void; i: number }) {
  return (
    <div className="blin-onb-item" style={{ ["--i" as string]: i }}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="blin-press"
        style={{
          ...btnReset,
          width: "100%",
          minHeight: 52,
          padding: "0 18px",
          borderRadius: T.radius.lg,
          border: "none",
          fontWeight: 600,
          fontSize: 15,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          cursor: disabled ? "not-allowed" : "pointer",
          background: T.orange,
          color: "#fff",
          opacity: disabled ? 0.45 : 1,
        }}
      >
        {children}
      </button>
    </div>
  );
}

// как Btn secondary
export const secondaryBtn: React.CSSProperties = {
  ...btnReset,
  width: "100%",
  minHeight: 52,
  padding: "0 18px",
  borderRadius: T.radius.lg,
  border: `1px solid ${T.border}`,
  background: T.surface,
  color: T.text,
  fontWeight: 600,
  fontSize: 15,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
};

export const glassCard: React.CSSProperties = {
  background: "rgba(30, 26, 22, 0.72)",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  border: `1px solid ${T.borderStrong}`,
  borderRadius: 22,
};

export function Spinner({ muted }: { muted?: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 18,
        height: 18,
        borderRadius: "50%",
        border: `2px solid ${muted ? "rgba(255,248,240,0.2)" : "rgba(255,255,255,0.35)"}`,
        borderTopColor: muted ? T.orange : "#fff",
        animation: "blinvpnSpin 0.8s linear infinite",
        flex: "none",
      }}
    />
  );
}

