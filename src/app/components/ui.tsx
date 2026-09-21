import React from "react";
import { T, btnReset, pageFrame, pageOuter } from "../theme";

type IconProps = {
  name: string;
  style?: React.CSSProperties;
  onClick?: () => void;
};

type BackCircleButtonProps = {
  onClick: () => void;
  left?: number;
  top?: number;
  ariaLabel?: string;
  iconSize?: number;
};

export function MSIcon({ name, style, onClick }: IconProps) {
  return (
    <span
      className="material-symbols-outlined"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 24,
        lineHeight: 1,
        fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24",
        userSelect: "none",
        ...style,
      }}
    >
      {name}
    </span>
  );
}

export function BackCircleButton({
  onClick,
  left = 26,
  top = 26,
  ariaLabel = "Назад",
  iconSize = 24,
}: BackCircleButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="blin-press"
      style={{
        ...btnReset,
        position: "absolute",
        width: 40,
        height: 40,
        left,
        top,
        background: T.surfaceRaised,
        borderRadius: "50%",
        border: `1px solid ${T.border}`,
        padding: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        zIndex: 2,
      }}
    >
      <MSIcon name="chevron_left" style={{ color: T.text, fontSize: iconSize }} />
    </button>
  );
}

/** Круглая кнопка «назад» для flex-шапок */
export function BackButton({ onClick, ariaLabel = "Назад" }: { onClick: () => void; ariaLabel?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="blin-press"
      style={{
        ...btnReset,
        flex: "0 0 auto",
        width: 40,
        height: 40,
        borderRadius: "50%",
        background: T.surfaceRaised,
        border: `1px solid ${T.border}`,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <MSIcon name="chevron_left" style={{ color: T.text, fontSize: 24 }} />
    </button>
  );
}

export function PageHeader({
  title,
  onBack,
  right,
}: {
  title: string;
  onBack: () => void;
  right?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 22 }}>
      <BackButton onClick={onBack} />
      <div
        style={{
          flex: 1,
          fontWeight: 700,
          fontSize: 24,
          letterSpacing: "-0.02em",
          color: T.text,
          minWidth: 0,
        }}
      >
        {title}
      </div>
      {right}
    </div>
  );
}

/** Оболочка экрана: ambient + скролл + фиксированная ширина */
export function Screen({
  children,
  scroll = true,
  pad = true,
  style,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  pad?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div style={pageOuter()}>
      <div style={pageFrame({ height: 803, overflow: "hidden", ...style })}>
        <div className="blin-ambient" aria-hidden />
        <div
          className={scroll ? "blin-scroll" : undefined}
          style={{
            position: "relative",
            zIndex: 1,
            height: "100%",
            padding: pad ? "22px 26px 32px" : undefined,
            boxSizing: "border-box",
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

type BtnVariant = "primary" | "secondary" | "ghost" | "danger";

export function Btn({
  children,
  onClick,
  disabled,
  variant = "primary",
  full = true,
  style,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: BtnVariant;
  full?: boolean;
  style?: React.CSSProperties;
  type?: "button" | "submit";
}) {
  const palette: Record<BtnVariant, React.CSSProperties> = {
    primary: {
      background: `linear-gradient(180deg, ${T.orangeBright} 0%, ${T.orange} 100%)`,
      color: "#fff",
      boxShadow: `0 8px 24px ${T.orangeGlow}`,
    },
    secondary: {
      background: T.surfaceRaised,
      color: T.text,
      border: `1px solid ${T.border}`,
    },
    ghost: {
      background: "transparent",
      color: T.textMuted,
    },
    danger: {
      background: T.dangerSoft,
      color: T.danger,
    },
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="blin-press"
      style={{
        ...btnReset,
        width: full ? "100%" : undefined,
        minHeight: 52,
        padding: "0 18px",
        borderRadius: T.radius.lg,
        border: "none",
        fontWeight: 600,
        fontSize: 16,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        ...palette[variant],
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export function Surface({
  children,
  style,
  onClick,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  onClick?: () => void;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={onClick ? "blin-press" : undefined}
      style={{
        ...(onClick ? btnReset : {}),
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: T.radius.xl,
        overflow: "hidden",
        width: onClick ? "100%" : undefined,
        cursor: onClick ? "pointer" : undefined,
        textAlign: onClick ? "left" : undefined,
        color: T.text,
        ...style,
      }}
    >
      {children}
    </Comp>
  );
}

export function Field({
  value,
  onChange,
  placeholder,
  type = "text",
  onKeyDown,
  autoFocus,
  maxLength,
  inputMode,
  autoComplete,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
  maxLength?: number;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  autoComplete?: string;
  style?: React.CSSProperties;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      autoFocus={autoFocus}
      maxLength={maxLength}
      inputMode={inputMode}
      autoComplete={autoComplete}
      style={{
        width: "100%",
        height: 54,
        borderRadius: T.radius.md,
        border: `1px solid ${T.borderStrong}`,
        background: T.surfaceRaised,
        color: T.text,
        padding: "0 16px",
        fontSize: 16,
        outline: "none",
        boxSizing: "border-box",
        fontFamily: T.font,
        ...style,
      }}
    />
  );
}

export function BrandMark({ size = "lg" }: { size?: "sm" | "lg" }) {
  const fontSize = size === "lg" ? 34 : 22;
  return (
    <div
      style={{
        fontWeight: 800,
        fontSize,
        letterSpacing: "-0.04em",
        lineHeight: 1,
        color: T.text,
      }}
    >
      Blin<span style={{ color: T.orange }}>VPN</span>
    </div>
  );
}

export function LoadingScreen({ text = "Загрузка…" }: { text?: string }) {
  return (
    <div style={pageOuter({ alignItems: "center", background: T.bgOuter })}>
      <div
        style={{
          ...pageFrame({ height: 803 }),
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 18,
        }}
      >
        <div className="blin-ambient" aria-hidden />
        <div
          style={{
            position: "relative",
            zIndex: 1,
            width: 52,
            height: 52,
            borderRadius: "50%",
            border: `4px solid ${T.orangeSoft}`,
            borderTopColor: T.orange,
            animation: "blinvpnSpin 0.85s linear infinite",
          }}
        />
        <div
          style={{
            position: "relative",
            zIndex: 1,
            color: T.text,
            fontSize: 15,
            fontWeight: 600,
            opacity: 0.8,
          }}
        >
          {text}
        </div>
      </div>
    </div>
  );
}

export { T, btnReset, pageFrame, pageOuter };
