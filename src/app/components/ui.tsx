import React from "react";

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

/**
 * Единая обертка для Material Symbols.
 * Нужна, чтобы не дублировать одинаковые настройки шрифта и выравнивания.
 */
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

/**
 * Универсальная круглая кнопка "Назад".
 * Внешний вид совпадает с текущим дизайном экранов (37x37, фон #313131).
 */
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
      style={{
        position: "absolute",
        width: "37px",
        height: "37px",
        left: `${left}px`,
        top: `${top}px`,
        background: "#313131",
        borderRadius: "50%",
        border: "none",
        padding: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
      }}
    >
      <MSIcon name="chevron_left" style={{ color: "#FFFFFF", fontSize: iconSize }} />
    </button>
  );
}

/**
 * Полноэкранный индикатор загрузки с оранжевой анимацией.
 * Используется, пока страница подгружает данные (вместо чёрного экрана).
 */
export function LoadingScreen({ text = "Загрузка…" }: { text?: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "100vh",
        background: "#111",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <div
        style={{
          width: "402px",
          height: "803px",
          background: "#212121",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "18px",
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            border: "5px solid rgba(241,135,38,0.2)",
            borderTopColor: "#F18726",
            animation: "blinvpnSpin 0.9s linear infinite",
          }}
        />
        <div style={{ color: "#FFFFFF", fontSize: 15, fontWeight: 600, opacity: 0.85 }}>
          {text}
        </div>
      </div>
      <style>{`@keyframes blinvpnSpin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
