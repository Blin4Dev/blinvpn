import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MSIcon, T, btnReset } from "./ui";

/*
  пошаговая инструкция поверх главной:
  всё размыто и затемнено, кроме «окна» над текущим элементом (он остаётся нажимаемым),
  окно плавно переезжает между элементами, рядом карточка-подсказка.
*/

export type TourStep = {
  target: () => HTMLElement | null;
  radius: number;
  title: string;
  text: string;
  /** последний шаг: вместо «Далее» — только «Позже», действие — сам подсвеченный элемент */
  final?: boolean;
};

type Rect = { x: number; y: number; w: number; h: number; r: number };

const PAD = 6;
const MOVE_MS = 520;
const GAP = 14;
const SIDE = 18;

function easeInOut(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// прямоугольник со скруглением — «дырка» в clip-path (evenodd)
function holePath(W: number, H: number, h: Rect): string {
  const r = Math.min(h.r, h.w / 2, h.h / 2);
  const x = h.x, y = h.y, w = h.w, hh = h.h;
  return (
    `path(evenodd, "M0 0H${W}V${H}H0Z ` +
    `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}` +
    `V${y + hh - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + hh}` +
    `H${x + r}A${r} ${r} 0 0 1 ${x} ${y + hh - r}` +
    `V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z")`
  );
}

export default function HomeTour({
  frameRef,
  steps,
  onFinish,
}: {
  frameRef: React.RefObject<HTMLDivElement>;
  steps: TourStep[];
  onFinish: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const [shown, setShown] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [size, setSize] = useState({ W: 0, H: 0 });
  const sizeRef = useRef({ W: 0, H: 0 });
  // окно в покое (по нему стоит слой размытия) и текущее положение во время переезда
  const [settled, setSettled] = useState<Rect | null>(null);
  const [moving, setMoving] = useState(false);
  // счётчик остановок окна: перезапускает плавное появление размытия
  const [settledKey, setSettledKey] = useState(0);
  const holeRef = useRef<Rect | null>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(0);
  const step = steps[idx];

  const [target, setTarget] = useState<Rect | null>(null);

  // чистое измерение: координаты элемента в системе страницы (учитывая --blin-scale)
  const measure = useCallback((): Rect | null => {
    const frame = frameRef.current;
    const el = step?.target();
    if (!frame || !el) return null;
    const f = frame.getBoundingClientRect();
    const scale = f.width / (frame.offsetWidth || f.width) || 1;
    const r = el.getBoundingClientRect();
    return {
      x: (r.left - f.left) / scale - PAD,
      y: (r.top - f.top) / scale - PAD,
      w: r.width / scale + PAD * 2,
      h: r.height / scale + PAD * 2,
      r: step.radius + PAD,
    };
  }, [frameRef, step]);

  // кадр переезда: без React, сразу в стили (затемнение + рамка)
  const paint = useCallback((h: Rect) => {
    const { W, H } = sizeRef.current;
    const path = holePath(W, H, h);
    const dim = dimRef.current;
    if (dim) {
      dim.style.clipPath = path;
      (dim.style as CSSStyleDeclaration & { webkitClipPath?: string }).webkitClipPath = path;
    }
    const ring = ringRef.current;
    if (ring) {
      ring.style.transform = `translate3d(${h.x}px, ${h.y}px, 0)`;
      ring.style.width = `${h.w}px`;
      ring.style.height = `${h.h}px`;
      ring.style.borderRadius = `${h.r}px`;
    }
  }, []);

  // плавный переезд окна к новому элементу; размытие на это время убирается (на слабых телефонах оно дорогое)
  useLayoutEffect(() => {
    const to = measure();
    if (!to) return;
    const frame = frameRef.current!;
    sizeRef.current = { W: frame.offsetWidth, H: frame.offsetHeight };
    setSize(sizeRef.current);
    setTarget(to);
    const from = holeRef.current;
    cancelAnimationFrame(raf.current);
    if (!from) {
      holeRef.current = to;
      setSettled(to);
      return;
    }
    setMoving(true);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / MOVE_MS);
      const k = easeInOut(t);
      const cur = {
        x: from.x + (to.x - from.x) * k,
        y: from.y + (to.y - from.y) * k,
        w: from.w + (to.w - from.w) * k,
        h: from.h + (to.h - from.h) * k,
        r: from.r + (to.r - from.r) * k,
      };
      holeRef.current = cur;
      paint(cur);
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else {
        setSettled(to);
        setMoving(false);
        setSettledKey((k) => k + 1);
      }
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [idx, measure, frameRef, paint]);

  useEffect(() => {
    const onResize = () => {
      const r = measure();
      const frame = frameRef.current;
      if (r && frame) {
        sizeRef.current = { W: frame.offsetWidth, H: frame.offsetHeight };
        setSize(sizeRef.current);
        setTarget(r);
        holeRef.current = r;
        setSettled(r);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure, frameRef]);

  useEffect(() => {
    const t = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(t);
  }, []);

  useLayoutEffect(() => {
    setCardH(cardRef.current?.offsetHeight || 0);
  }, [idx, size.W]);

  const finish = () => {
    setLeaving(true);
    window.setTimeout(onFinish, 320);
  };
  const next = () => {
    haptic("light");
    if (idx + 1 < steps.length) setIdx(idx + 1);
    else finish();
  };

  const hole = holeRef.current;
  if (!hole || !settled || !target || !size.W) return null;

  // карточка: над элементом, если сверху хватает места, иначе под ним
  const above = target.y - GAP - cardH > 24;
  const cardTop = above ? target.y - GAP - cardH : target.y + target.h + GAP;
  const cardW = size.W - SIDE * 2;
  const arrowX = Math.max(26, Math.min(cardW - 26, target.x + target.w / 2 - SIDE));
  const visible = shown && !leaving;

  return (
    // контейнер прозрачен для нажатий: клики ловит только затемнение (окно в нём вырезано) и карточка
    <div style={{ position: "absolute", inset: 0, zIndex: 40, pointerEvents: "none" }} aria-live="polite">
      {/* размытие (без затемнения): стоит по окну в покое */}
      <div
        key={`blur${settledKey}`}
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          backdropFilter: "blur(7px)",
          WebkitBackdropFilter: "blur(7px)",
          clipPath: holePath(size.W, size.H, settled),
          WebkitClipPath: holePath(size.W, size.H, settled),
          // на время переезда слой размытия убираем совсем (пересчёт размытия каждый кадр — самое дорогое
          // на слабых телефонах), затемнение в это время чуть плотнее; после остановки — плавно возвращаем
          display: moving ? "none" : "block",
          opacity: visible ? 1 : 0,
          animation: !moving && settledKey > 0 ? "blinvpnFadeIn 0.25s ease both" : undefined,
          transition: "opacity 0.45s ease",
          pointerEvents: "none",
        }}
      />
      {/* затемнение с окном: двигается каждый кадр (дёшево — сплошной цвет) */}
      <div
        ref={dimRef}
        style={{
          position: "absolute",
          inset: 0,
          background: moving ? "rgba(10, 8, 6, 0.7)" : "rgba(10, 8, 6, 0.6)",
          clipPath: holePath(size.W, size.H, hole),
          WebkitClipPath: holePath(size.W, size.H, hole),
          opacity: visible ? 1 : 0,
          transition: "opacity 0.45s ease, background 0.2s ease",
          pointerEvents: leaving ? "none" : "auto",
        }}
      />
      {/* тонкая рамка вокруг окна */}
      <div
        ref={ringRef}
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          transform: `translate3d(${hole.x}px, ${hole.y}px, 0)`,
          width: hole.w,
          height: hole.h,
          borderRadius: hole.r,
          border: "1.5px solid rgba(255, 138, 61, 0.55)",
          boxShadow: "0 0 0 5px rgba(255, 107, 26, 0.10)",
          pointerEvents: "none",
          opacity: visible ? 1 : 0,
          transition: "opacity 0.45s ease",
          willChange: "transform",
        }}
      />

      {/* подсказка */}
      <div
        ref={cardRef}
        style={{
          position: "absolute",
          left: SIDE,
          width: cardW,
          top: cardTop,
          transition: `top ${MOVE_MS}ms cubic-bezier(0.65, 0, 0.35, 1), opacity 0.35s ease`,
          opacity: visible && cardH ? 1 : 0,
          pointerEvents: leaving ? "none" : "auto",
        }}
      >
        <div
          key={idx}
          className="blin-tour-card"
          style={{
            position: "relative",
            background: T.surface,
            border: `1px solid ${T.borderStrong}`,
            borderRadius: T.radius.lg,
            padding: "16px 16px 12px",
            boxShadow: "0 18px 50px rgba(0, 0, 0, 0.5)",
          }}
        >
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: arrowX - 8,
              [above ? "bottom" : "top"]: -8,
              width: 16,
              height: 16,
              background: T.surface,
              borderRight: `1px solid ${T.borderStrong}`,
              borderBottom: `1px solid ${T.borderStrong}`,
              transform: `rotate(${above ? 45 : 225}deg)`,
              borderBottomRightRadius: 3,
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: T.orange, letterSpacing: "0.02em" }}>
              {idx + 1} из {steps.length}
            </span>
            <span style={{ display: "flex", gap: 4 }}>
              {steps.map((_, i) => (
                <span
                  key={i}
                  style={{
                    width: i === idx ? 14 : 5,
                    height: 5,
                    borderRadius: 3,
                    background: i <= idx ? T.orange : "rgba(255, 248, 240, 0.16)",
                    transition: "width 0.35s var(--ease-out), background 0.3s ease",
                  }}
                />
              ))}
            </span>
          </div>
          <div style={{ fontWeight: 700, fontSize: 18, letterSpacing: "-0.02em", color: T.text, lineHeight: 1.25 }}>{step.title}</div>
          <div style={{ fontSize: 14, lineHeight: 1.45, color: T.textMuted, marginTop: 6 }}>{step.text}</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12 }}>
            <button
              type="button"
              onClick={finish}
              className="blin-press"
              style={{ ...btnReset, border: "none", background: "transparent", color: T.textMuted, fontSize: 14, fontWeight: 500, padding: "10px 4px", cursor: "pointer" }}
            >
              {step.final ? "Позже" : "Пропустить"}
            </button>
            {step.final ? (
              <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, color: T.textDim }}>
                <MSIcon name={above ? "south" : "north"} style={{ fontSize: 16, color: T.orange }} />
                нажмите на кнопку
              </span>
            ) : (
              <button
                type="button"
                onClick={next}
                className="blin-press"
                style={{
                  ...btnReset,
                  border: "none",
                  background: T.orange,
                  color: "#fff",
                  fontWeight: 600,
                  fontSize: 14,
                  height: 38,
                  padding: "0 18px",
                  borderRadius: 12,
                  cursor: "pointer",
                }}
              >
                Далее
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function haptic(s: "light" | "medium") {
  try {
    (window as unknown as { Telegram?: { WebApp?: { HapticFeedback?: { impactOccurred?: (s: string) => void } } } })
      .Telegram?.WebApp?.HapticFeedback?.impactOccurred?.(s);
  } catch { /* ignore */ }
}
