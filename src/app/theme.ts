import type { CSSProperties } from "react";

/**
 * BlinVPN design tokens — тёплый уголь + эмбер-оранжевый.
 * Один источник правды для inline-стилей и JS-логики.
 */
export const T = {
  bg: "#14110E",
  bgOuter: "#14110E",
  surface: "#1E1A16",
  surfaceRaised: "#2A241E",
  surfaceHover: "#352E26",
  border: "rgba(255, 248, 240, 0.08)",
  borderStrong: "rgba(255, 248, 240, 0.14)",
  orange: "#FF6B1A",
  orangeBright: "#FF8A3D",
  orangeDeep: "#C44E0A",
  orangeSoft: "rgba(255, 107, 26, 0.16)",
  orangeGlow: "rgba(255, 107, 26, 0.35)",
  text: "#FFF8F0",
  textMuted: "#A89B8C",
  textDim: "#6F6458",
  danger: "#FF5C5C",
  dangerSoft: "rgba(255, 92, 92, 0.14)",
  success: "#6BCB8A",
  successSoft: "rgba(107, 203, 138, 0.14)",
  info: "#7FB2FF",
  infoSoft: "rgba(127, 178, 255, 0.18)",
  font: "'Outfit', system-ui, sans-serif",
  width: 402,
  radius: { sm: 12, md: 16, lg: 20, xl: 26, pill: 999 },
} as const;

export const btnReset: CSSProperties = {
  boxSizing: "border-box",
  WebkitTapHighlightColor: "transparent",
  touchAction: "manipulation",
  outline: "none",
  appearance: "none",
  WebkitAppearance: "none",
  fontFamily: T.font,
};

/** Обёртка страницы под макет 402px */
export function pageFrame(extra?: CSSProperties): CSSProperties {
  return {
    position: "relative",
    boxSizing: "border-box",
    width: T.width,
    height: "100%",
    minHeight: "100%",
    margin: "0 auto",
    background: T.bg,
    fontFamily: T.font,
    overflow: "hidden",
    flexShrink: 0,
    color: T.text,
    WebkitFontSmoothing: "antialiased",
    ...extra,
  };
}

export function pageOuter(extra?: CSSProperties): CSSProperties {
  return {
    display: "flex",
    justifyContent: "center",
    alignItems: "stretch",
    width: "100%",
    height: "100%",
    background: T.bg,
    fontFamily: T.font,
    ...extra,
  };
}
