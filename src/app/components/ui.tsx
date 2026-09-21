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
        background: T.surface,
        borderRadius: 12,
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
        borderRadius: 12,
        background: T.surface,
        border: `1px solid ${T.border}`,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <MSIcon name="chevron_left" style={{ color: T.text, fontSize: 22 }} />
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
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        marginBottom: 24,
        paddingTop: 4,
      }}
    >
      <BackButton onClick={onBack} />
      <div
        style={{
          flex: 1,
          fontWeight: 600,
          fontSize: 20,
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

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontWeight: 500,
        fontSize: 12,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: T.textDim,
        margin: "20px 2px 10px",
      }}
    >
      {children}
    </div>
  );
}

/** Строка списка в стиле главной: спокойная, без оранжевых плашек */
export function ListRow({
  title,
  subtitle,
  meta,
  icon,
  onClick,
  last,
}: {
  title: string;
  subtitle?: string;
  meta?: string;
  icon?: string;
  onClick?: () => void;
  last?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={onClick ? "blin-press" : undefined}
      style={{
        ...btnReset,
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        padding: "14px 0",
        background: "transparent",
        border: "none",
        borderBottom: last ? "none" : `1px solid ${T.border}`,
        cursor: onClick ? "pointer" : "default",
        textAlign: "left",
        color: T.text,
      }}
    >
      {icon ? (
        <MSIcon name={icon} style={{ color: T.textMuted, fontSize: 22, flexShrink: 0 }} />
      ) : null}
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "block", fontWeight: 500, fontSize: 15, color: T.text }}>{title}</span>
        {subtitle ? (
          <span style={{ display: "block", fontWeight: 400, fontSize: 13, color: T.textMuted, marginTop: 2 }}>
            {subtitle}
          </span>
        ) : null}
      </span>
      {meta ? (
        <span style={{ fontSize: 13, color: T.textMuted, whiteSpace: "nowrap", flexShrink: 0 }}>{meta}</span>
      ) : null}
      {onClick ? <MSIcon name="chevron_right" style={{ color: T.textDim, fontSize: 20, flexShrink: 0 }} /> : null}
    </button>
  );
}

/** Кнопка-действие как на главной */
export function ActionButton({
  title,
  meta,
  icon,
  onClick,
  primary,
  disabled,
}: {
  title: string;
  meta?: string;
  icon?: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="blin-press"
      style={{
        ...btnReset,
        width: "100%",
        minHeight: 52,
        padding: "0 16px",
        border: primary ? "none" : `1px solid ${T.border}`,
        background: primary ? T.orange : T.surface,
        borderRadius: T.radius.lg,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      {icon ? (
        <MSIcon name={icon} style={{ fontSize: 22, color: primary ? "#fff" : T.textMuted, flexShrink: 0 }} />
      ) : null}
      <span
        style={{
          flex: 1,
          fontWeight: 600,
          fontSize: 15,
          color: primary ? "#fff" : T.text,
          textAlign: "left",
        }}
      >
        {title}
      </span>
      {meta ? (
        <span
          style={{
            fontSize: 13,
            color: primary ? "rgba(255,255,255,0.75)" : T.textMuted,
            whiteSpace: "nowrap",
          }}
        >
          {meta}
        </span>
      ) : null}
      <MSIcon
        name="chevron_right"
        style={{ fontSize: 20, color: primary ? "rgba(255,255,255,0.7)" : T.textDim, flexShrink: 0 }}
      />
    </button>
  );
}

/** Оболочка внутренних экранов — без сильного ambient, как спокойный кабинет */
export function Screen({
  children,
  scroll = true,
  pad = true,
  ambient = false,
  style,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  pad?: boolean;
  ambient?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div style={pageOuter()}>
      <div style={pageFrame({ overflow: "hidden", ...style })}>
        {ambient ? <div className="blin-ambient" aria-hidden /> : null}
        <div
          className={scroll ? "blin-scroll blin-tg-safe" : "blin-tg-safe"}
          style={{
            position: "relative",
            zIndex: 1,
            height: "100%",
            paddingLeft: pad ? 26 : undefined,
            paddingRight: pad ? 26 : undefined,
            paddingBottom: pad ? 28 : undefined,
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
      background: T.orange,
      color: "#fff",
    },
    secondary: {
      background: T.surface,
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
        fontSize: 15,
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
  padded,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  onClick?: () => void;
  padded?: boolean;
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
        borderRadius: T.radius.lg,
        overflow: "hidden",
        width: onClick ? "100%" : undefined,
        cursor: onClick ? "pointer" : undefined,
        textAlign: onClick ? "left" : undefined,
        color: T.text,
        padding: padded ? "4px 16px" : undefined,
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
        height: 52,
        borderRadius: T.radius.md,
        border: `1px solid ${T.border}`,
        background: T.surface,
        color: T.text,
        padding: "0 16px",
        fontSize: 15,
        outline: "none",
        boxSizing: "border-box",
        fontFamily: T.font,
        ...style,
      }}
    />
  );
}

export function BrandMark({ size = "lg" }: { size?: "sm" | "lg" }) {
  const fontSize = size === "lg" ? 32 : 20;
  return (
    <div
      style={{
        fontWeight: 700,
        fontSize,
        letterSpacing: "-0.03em",
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
    <div style={pageOuter({ alignItems: "center" })}>
      <div
        style={{
          ...pageFrame(),
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: "50%",
            border: `3px solid ${T.borderStrong}`,
            borderTopColor: T.orange,
            animation: "blinvpnSpin 0.8s linear infinite",
          }}
        />
        <div style={{ color: T.textMuted, fontSize: 14, fontWeight: 500 }}>{text}</div>
      </div>
    </div>
  );
}

export { T, btnReset, pageFrame, pageOuter };
