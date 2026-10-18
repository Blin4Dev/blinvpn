import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { acceptTerms, appFetch, fetchConfig, fetchLegal, fetchMe, fetchMembership, getWebRef, setAppToken, tgWebApp, type AppUser, type EmailRequestResult, type Membership, type TelegramOAuthPayload } from "../utils/api";
import { CodeStep, EmailStep, type AuthConfig } from "./AuthSteps";
import { MSIcon, T, btnReset, pageFrame, pageOuter } from "../components/ui";
import { PrimaryButton, Spinner, Sub, Title, glassCard, haptic, secondaryBtn } from "../components/onbUi";
import { RichText } from "../components/RichText";

/*
  онбординг первого входа: логотип со сплэша уезжает вверх (не до конца),
  снизу появляются шаги: оферта → канал → финальная анимация.
  финал заканчивается логотипом по центру — ровно там, где стартует интро главной.
*/

type Step = "email" | "code" | "terms" | "channel";
const isAuthStep = (s?: Step) => s === "email" || s === "code";
type Doc = "offer" | "privacy";
type Phase = "splash" | "steps" | "final";

const DOC_TITLE: Record<Doc, string> = { offer: "Договор оферты", privacy: "Политика конфиденциальности" };

// тайминги (мс)
const SPLASH_HOLD = 280;
const SWITCH_OUT = 380;
const FINAL_TOTAL = 2300;
const HANDOFF_LEAD = 500;

const LOGO_UP_SCALE = 0.8;

function channelHandle(url: string): string {
  const m = /t\.me\/([A-Za-z0-9_]+)/.exec(url);
  return m ? `@${m[1]}` : "Telegram-канал";
}

export default function Onboarding({
  needAuth = false,
  overlay = false,
  onAuthed,
  needTerms,
  membership,
  onHandoff,
  onDone,
}: {
  /** вход на сайте: сначала email → код, дальше шаги определяются после входа */
  needAuth?: boolean;
  /** показываем поверх уже открытой главной (поздняя проверка канала) — плавное появление */
  overlay?: boolean;
  onAuthed?: () => void;
  needTerms: boolean;
  membership: Membership | null;
  /** за ~0.5 с до конца: можно монтировать главную под оверлеем */
  onHandoff?: () => void;
  /** какие шаги пройдены — чтобы не спрашивать их снова */
  onDone: (passed: { terms: boolean; channel: boolean }) => void;
}) {
  const [steps, setSteps] = useState<Step[]>(() => {
    if (needAuth) return ["email", "code"];
    const s: Step[] = [];
    if (needTerms) s.push("terms");
    if (membership && membership.required && !membership.subscribed) s.push("channel");
    return s;
  });
  const [mem, setMem] = useState<Membership | null>(membership);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const doneInfo = () => ({ terms: stepsRef.current.includes("terms"), channel: stepsRef.current.includes("channel") });

  const [phase, setPhase] = useState<Phase>("splash");
  const [idx, setIdx] = useState(0);
  const [leaving, setLeaving] = useState<false | "fwd" | "back">(false);
  // первый показ шага — подъём снизу, дальше — слайд справа (назад — слева)
  const [enterMode, setEnterMode] = useState<"rise" | "slide" | "slide-back">("rise");
  const [flipKey, setFlipKey] = useState(0);
  const step = steps[idx];

  // геометрия: где центр логотипа в состоянии «вверху»
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const topPadRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState({ h: 0, contentH: 0, topPad: 0, logo: 200 });

  useLayoutEffect(() => {
    const measure = () => {
      setGeo({
        h: frameRef.current?.clientHeight || 0,
        contentH: contentRef.current?.offsetHeight || 0,
        topPad: topPadRef.current?.offsetHeight || 0,
        logo: logoRef.current?.offsetHeight || 200,
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (frameRef.current) ro.observe(frameRef.current);
    if (contentRef.current) ro.observe(contentRef.current);
    return () => ro.disconnect();
  }, []);

  const up = phase === "steps";
  const avail = Math.max(0, geo.h - geo.topPad - geo.contentH);
  const upScale = Math.max(0.5, Math.min(LOGO_UP_SCALE, (avail - 28) / Math.max(1, geo.logo)));
  const upCenter = geo.topPad + avail / 2 + 4;
  const logoY = up && geo.h ? upCenter - geo.h / 2 : 0;
  const logoScale = up ? upScale : 1;

  // сплэш → подъём
  useEffect(() => {
    if (!steps.length) {
      onDone(doneInfo());
      return;
    }
    const t = window.setTimeout(() => setPhase("steps"), SPLASH_HOLD);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finalize = useCallback(() => {
    setLeaving("fwd");
    window.setTimeout(() => {
      setPhase("final");
      window.setTimeout(() => haptic()?.notificationOccurred?.("success"), 650);
      if (onHandoff) window.setTimeout(onHandoff, FINAL_TOTAL - HANDOFF_LEAD);
      window.setTimeout(() => onDone(doneInfo()), FINAL_TOTAL);
    }, 120);
  }, [onDone, onHandoff]);

  // переход на шаг target; list — новый список шагов (после входа он дополняется)
  const go = useCallback(
    (target: number, list: Step[], back = false) => {
      const from = list[idx] ?? steps[idx];
      const to = list[target];
      // разворот логотипа — между разделами; email ⇄ код — просто слайд
      const flip = !(isAuthStep(from) && isAuthStep(to));
      setLeaving(back ? "back" : "fwd");
      if (flip) {
        setFlipKey((k) => k + 1);
        haptic()?.impactOccurred?.("medium");
      }
      window.setTimeout(() => {
        setEnterMode(back ? "slide-back" : "slide");
        setSteps(list);
        setIdx(target);
        setLeaving(false);
      }, SWITCH_OUT);
    },
    [idx, steps],
  );

  const next = useCallback(
    (list: Step[] = steps) => {
      if (idx + 1 < list.length) go(idx + 1, list);
      else finalize();
    },
    [idx, steps, go, finalize],
  );

  // ответ про канал пришёл позже (сервер медленно проверял) — добавляем шаг в конец
  useEffect(() => {
    if (!membership || !membership.required || membership.subscribed) return;
    if (phase === "final" || stepsRef.current.includes("channel")) return;
    // пока идёт вход (email/код) — шаги после входа определит afterAuth
    if (isAuthStep(stepsRef.current[idx])) return;
    setMem(membership);
    setSteps((s) => (s.includes("channel") ? s : [...s, "channel"]));
  }, [membership, phase, idx]);

  // ───── вход на сайте ─────
  const [authCfg, setAuthCfg] = useState<AuthConfig>({ botUsername: "", botId: "", captcha: null });
  const [authEmail, setAuthEmail] = useState("");
  const [sent, setSent] = useState<{ resendAfter: number; devCode?: string }>({ resendAfter: 60 });
  useEffect(() => {
    if (!needAuth) return;
    void fetchConfig().then((c) => {
      const conf = c as { botUsername?: string; telegramOauthBotId?: string; captcha?: AuthConfig["captcha"] };
      setAuthCfg({
        botUsername: (conf.botUsername || "").trim().replace(/^@/, ""),
        botId: String(conf.telegramOauthBotId || ""),
        captcha: conf.captcha && typeof conf.captcha === "object" ? conf.captcha : null,
      });
    });
  }, [needAuth]);

  // после входа: узнаём, нужны ли оферта и канал, и продолжаем без повторного сплэша
  const afterAuth = useCallback(async () => {
    onAuthed?.();
    const [me, m] = await Promise.all([fetchMe(), fetchMembership()]);
    const extra: Step[] = [];
    if (me && me.terms_accepted === false) extra.push("terms");
    if (m.required && !m.subscribed) {
      setMem(m);
      extra.push("channel");
    }
    const list: Step[] = [...steps.slice(0, idx + 1), ...extra];
    next(list);
  }, [onAuthed, steps, idx, next]);

  const telegramLogin = useCallback(
    async (payload: TelegramOAuthPayload) => {
      const clean: Record<string, string | number> = { id: payload.id, hash: payload.hash };
      if (payload.first_name) clean.first_name = payload.first_name;
      if (payload.last_name) clean.last_name = payload.last_name;
      if (payload.username) clean.username = payload.username;
      if (payload.photo_url) clean.photo_url = payload.photo_url;
      if (payload.auth_date != null && payload.auth_date !== "") clean.auth_date = payload.auth_date;
      const ref = getWebRef();
      const b = await appFetch<{ user?: AppUser; token?: string }>("/auth/oauth", {
        method: "POST",
        body: JSON.stringify(ref ? { ...clean, ref } : clean),
      });
      if (b.token) setAppToken(b.token);
      // через telegram кода нет: убираем шаг «код» и идём дальше
      const list = steps.filter((s) => s !== "code");
      setSteps(list);
      onAuthed?.();
      const [me, mm] = await Promise.all([fetchMe(), fetchMembership()]);
      const extra: Step[] = [];
      if (me && me.terms_accepted === false) extra.push("terms");
      if (mm.required && !mm.subscribed) {
        setMem(mm);
        extra.push("channel");
      }
      next([...list.slice(0, idx + 1), ...extra]);
    },
    [steps, idx, next, onAuthed],
  );

  // шторка документа
  const [doc, setDoc] = useState<Doc | null>(null);
  const [docOpen, setDocOpen] = useState(false);
  const [docs, setDocs] = useState<Record<Doc, string> | null>(null);
  const openDoc = async (d: Doc) => {
    setDoc(d);
    requestAnimationFrame(() => setDocOpen(true));
    haptic()?.impactOccurred?.("light");
    if (!docs) {
      try {
        const l = await fetchLegal();
        setDocs({ offer: l.offer || "Документ пока не опубликован.", privacy: l.privacy || "Документ пока не опубликован." });
      } catch {
        setDocs({ offer: "Не удалось загрузить документ. Попробуйте позже.", privacy: "Не удалось загрузить документ. Попробуйте позже." });
      }
    }
  };
  const closeDoc = () => {
    setDocOpen(false);
    window.setTimeout(() => setDoc(null), 320);
  };

  const final = phase === "final";
  const postSteps = steps.filter((s) => !isAuthStep(s));
  const showContent = phase === "steps";

  return (
    <div
      style={{ ...pageOuter(), position: "fixed", inset: 0, zIndex: 3100, animation: overlay ? "blinvpnFadeIn 0.35s ease both" : undefined }}
      role="dialog"
      aria-modal="true"
    >
      <div ref={frameRef} style={pageFrame()}>
        <div ref={topPadRef} aria-hidden style={{ position: "absolute", top: 0, height: "calc(var(--blin-tg-pad-top, 0px) / var(--blin-scale))" }} />

        {/* фон: тёплое свечение */}
        <div
          aria-hidden
          className="blin-onb-bg"
          style={{
            opacity: phase === "splash" ? 0 : final ? 0 : 1,
            transition: final ? "opacity 0.9s ease 1.45s" : "opacity 1.3s var(--ease-out) 0.15s",
          }}
        >
          <div className="blin-onb-ambient" />
          {/* затемнение под текстом */}
          <div className="blin-onb-scrim" style={{ height: geo.contentH + 70 }} />
        </div>

        {/* логотип */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: `translate3d(-50%, calc(-50% + ${logoY}px), 0) scale(${logoScale})`,
            transition: final
              ? "transform 0.95s cubic-bezier(0.65, 0, 0.35, 1) 0.15s"
              : "transform 1.15s cubic-bezier(0.33, 1, 0.32, 1)",
            zIndex: 2,
            willChange: "transform",
          }}
        >
          <div
            ref={logoRef}
            style={{
              position: "relative",
              width: "min(200px, 42vh)",
              height: "min(200px, 42vh)",
              maxWidth: 200,
              maxHeight: 200,
              perspective: 700,
            }}
          >
            {/* вспышка при смене шага */}
            {flipKey > 0 && !final ? <span key={`p${flipKey}`} className="blin-onb-pulse" /> : null}
            {/* финальный взрыв колец */}
            {final ? (
              <>
                <span className="blin-onb-burst" style={{ animationDelay: "0.75s" }} />
                <span className="blin-onb-burst" style={{ animationDelay: "0.9s" }} />
                <span className="blin-onb-burst" style={{ animationDelay: "1.05s" }} />
                <span className="blin-onb-flash" />
              </>
            ) : null}
            <div
              aria-hidden
              style={{
                position: "absolute",
                inset: -18,
                borderRadius: "50%",
                background: `radial-gradient(circle, ${T.orangeGlow} 0%, transparent 66%)`,
                opacity: phase === "splash" ? 0 : final ? 0 : 1,
                transition: final ? "opacity 0.8s ease 1.5s" : "opacity 1.2s ease 0.3s",
              }}
            />
            <img
              key={`l${flipKey}`}
              src="/assets/logo.png"
                decoding="sync"
              width={200}
              height={200}
              alt="BlinVPN"
              draggable={false}
              className={flipKey > 0 && !final ? "blin-onb-flip" : undefined}
              style={{ position: "relative", width: "100%", height: "100%", objectFit: "contain", display: "block", userSelect: "none" }}
            />
          </div>
          {final ? <div className="blin-onb-done">Всё готово</div> : null}
        </div>

        {/* шаги */}
        <div
          ref={contentRef}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 3,
            padding: "0 26px calc(30px + var(--blin-tg-pad-bottom, 0px) / var(--blin-scale))",
            pointerEvents: showContent && !leaving ? "auto" : "none",
            visibility: phase === "splash" ? "hidden" : "visible",
          }}
        >
          <div key={step} className={final ? "blin-onb-exit-down" : leaving === "back" ? "blin-onb-exit-back" : leaving ? "blin-onb-exit" : `blin-onb-enter-${enterMode}`}>
            {!isAuthStep(step) && postSteps.length > 1 ? <Progress total={postSteps.length} idx={postSteps.indexOf(step)} /> : null}
            {step === "email" ? (
              <EmailStep
                cfg={authCfg}
                initialEmail={authEmail}
                onSent={(email: string, r: EmailRequestResult) => {
                  setAuthEmail(email);
                  setSent({ resendAfter: r.resend_after || 60, devCode: r.dev_code });
                  go(idx + 1, steps);
                }}
                onTelegram={telegramLogin}
              />
            ) : step === "code" ? (
              <CodeStep
                cfg={authCfg}
                email={authEmail}
                resendAfter={sent.resendAfter}
                devCode={sent.devCode}
                onBack={() => go(idx - 1, steps, true)}
                onResent={(r) => setSent({ resendAfter: r.resend_after || 60, devCode: r.dev_code })}
                onVerified={afterAuth}
              />
            ) : step === "terms" ? (
              <TermsStep onDone={() => next()} onOpenDoc={(d) => void openDoc(d)} />
            ) : step === "channel" && mem ? (
              <ChannelStep membership={mem} onDone={() => next()} />
            ) : null}
          </div>
        </div>

        {/* шторка документа */}
        {doc ? (
          <div style={{ position: "absolute", inset: 0, zIndex: 10 }}>
            <div
              onClick={closeDoc}
              style={{
                position: "absolute",
                inset: 0,
                background: "rgba(8, 6, 4, 0.55)",
                backdropFilter: "blur(6px)",
                WebkitBackdropFilter: "blur(6px)",
                opacity: docOpen ? 1 : 0,
                transition: "opacity 0.3s ease",
              }}
            />
            <div
              role="dialog"
              aria-label={DOC_TITLE[doc]}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                maxHeight: "78%",
                display: "flex",
                flexDirection: "column",
                background: T.surface,
                borderTop: `1px solid ${T.borderStrong}`,
                borderRadius: "28px 28px 0 0",
                padding: "22px 22px calc(22px + var(--blin-tg-pad-bottom, 0px) / var(--blin-scale))",
                transform: docOpen ? "translate3d(0,0,0)" : "translate3d(0,100%,0)",
                transition: docOpen ? "transform 0.42s cubic-bezier(0.22, 1.2, 0.36, 1)" : "transform 0.3s cubic-bezier(0.4, 0, 1, 1)",
                boxShadow: "0 -20px 60px rgba(0,0,0,0.45)",
              }}
            >
              <div style={{ width: 38, height: 4, borderRadius: 4, background: T.borderStrong, margin: "-10px auto 14px" }} />
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                <div style={{ flex: 1, fontWeight: 700, fontSize: 21, letterSpacing: "-0.02em", color: T.text }}>{DOC_TITLE[doc]}</div>
                <button
                  type="button"
                  aria-label="Закрыть"
                  onClick={closeDoc}
                  className="blin-press"
                  style={{ ...btnReset, width: 40, height: 40, borderRadius: 14, border: "none", background: T.surfaceRaised, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                >
                  <MSIcon name="close" style={{ fontSize: 22, color: T.text }} />
                </button>
              </div>
              <div style={{ flex: "1 1 auto", minHeight: 80, overflowY: "auto", overscrollBehavior: "contain", scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}>
                {docs ? <RichText text={docs[doc]} /> : <div style={{ fontSize: 14, color: T.textMuted }}>Загрузка…</div>}
              </div>
              <button type="button" onClick={closeDoc} className="blin-press" style={{ ...secondaryBtn, marginTop: 16 }}>
                Понятно
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ───────────────────────── шаги ───────────────────────── */

function Progress({ total, idx }: { total: number; idx: number }) {
  return (
    <div className="blin-onb-item" style={{ display: "flex", gap: 6, marginBottom: 18, ["--i" as string]: 0 }}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          style={{
            height: 4,
            width: i === idx ? 28 : 12,
            borderRadius: 4,
            background: i <= idx ? T.orange : "rgba(255, 248, 240, 0.16)",
            boxShadow: i === idx ? `0 0 12px ${T.orangeGlow}` : "none",
            transition: "width 0.5s var(--ease-out), background 0.4s ease",
          }}
        />
      ))}
    </div>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        flex: "none",
        width: 26,
        height: 26,
        marginTop: 1,
        borderRadius: 8,
        boxSizing: "border-box",
        border: `2px solid ${checked ? T.orange : "rgba(255, 248, 240, 0.28)"}`,
        background: checked ? T.orange : "rgba(255, 248, 240, 0.04)",
        boxShadow: checked ? `0 0 16px ${T.orangeGlow}` : "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transform: checked ? "scale(1)" : "scale(0.94)",
        transition: "background 0.22s ease, border-color 0.22s ease, box-shadow 0.3s ease, transform 0.3s cubic-bezier(0.34, 1.8, 0.5, 1)",
      }}
    >
      <svg viewBox="0 0 24 24" width="18" height="18">
        <path
          d="M5 12.5l4.2 4.2L19 7"
          fill="none"
          stroke="#fff"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ strokeDasharray: 24, strokeDashoffset: checked ? 0 : 24, transition: "stroke-dashoffset 0.28s ease 0.06s" }}
        />
      </svg>
    </span>
  );
}

function TermsStep({ onDone, onOpenDoc }: { onDone: () => void; onOpenDoc: (d: Doc) => void }) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const toggle = () => {
    setChecked((c) => !c);
    haptic()?.selectionChanged?.();
  };

  const accept = async () => {
    if (!checked || busy) return;
    setBusy(true);
    setErr("");
    try {
      await acceptTerms();
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось сохранить. Попробуйте ещё раз.");
      haptic()?.notificationOccurred?.("error");
      setBusy(false);
    }
  };

  const link = (d: Doc, label: string) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpenDoc(d);
      }}
      style={{
        ...btnReset,
        background: "transparent",
        border: "none",
        padding: 0,
        color: T.orangeBright,
        fontWeight: 500,
        fontSize: "inherit",
        textDecoration: "underline",
        textDecorationThickness: 1.5,
        textUnderlineOffset: 4,
        cursor: "pointer",
        display: "inline",
        textAlign: "left",
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <Title i={1}>Добро пожаловать!</Title>
      <Sub i={2}>Перед началом прочитайте условия использования BlinVPN.</Sub>
      <div
        className="blin-onb-item"
        role="checkbox"
        aria-checked={checked}
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            toggle();
          }
        }}
        style={{
          ["--i" as string]: 3,
          ...glassCard,
          display: "flex",
          gap: 14,
          alignItems: "flex-start",
          padding: "18px 18px",
          cursor: "pointer",
          outline: "none",
          borderColor: checked ? "rgba(255, 107, 26, 0.38)" : T.borderStrong,
          transition: "border-color 0.3s ease",
          WebkitTapHighlightColor: "transparent",
        }}
      >
        <Checkbox checked={checked} />
        <span style={{ fontSize: 16, lineHeight: 1.55, color: T.text }}>
          Я прочитал(а) и принимаю
          <br />
          {link("offer", "договор оферты")} и
          <br />
          {link("privacy", "политику конфиденциальности")}
        </span>
      </div>
      <div style={{ height: 16 }} />
      <PrimaryButton i={4} disabled={!checked || busy} onClick={() => void accept()}>
        {busy ? <Spinner /> : null}
        {busy ? "Сохраняем…" : "Продолжить"}
      </PrimaryButton>
      {err ? <div style={{ fontSize: 13, color: T.danger, marginTop: 10, textAlign: "center" }}>{err}</div> : null}
    </>
  );
}

function ChannelStep({ membership, onDone }: { membership: Membership; onDone: () => void }) {
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState("");
  const [shake, setShake] = useState(0);
  const [opened, setOpened] = useState(false);
  const channelUrl = membership.channel_url || "https://t.me/blinvpn";
  const handle = channelHandle(channelUrl);

  const openChannel = () => {
    haptic()?.impactOccurred?.("light");
    setOpened(true);
    setErr("");
    const wa = tgWebApp();
    if (wa?.openTelegramLink && /^https?:\/\/t\.me\//i.test(channelUrl)) wa.openTelegramLink(channelUrl);
    else if (wa?.openLink) wa.openLink(channelUrl);
    else window.open(channelUrl, "_blank", "noopener,noreferrer");
  };

  const recheck = useCallback(
    async (silent = false) => {
      if (checking) return;
      setChecking(true);
      if (!silent) setErr("");
      const m = await fetchMembership(true);
      setChecking(false);
      if (m.subscribed) {
        onDone();
        return;
      }
      if (!silent) {
        setErr("Подписка пока не видна. Подпишитесь и нажмите ещё раз.");
        setShake((s) => s + 1);
        haptic()?.notificationOccurred?.("error");
      }
    },
    [checking, onDone],
  );

  // вернулся из канала → тихо проверяем сами
  useEffect(() => {
    if (!opened) return;
    const onVis = () => {
      if (document.visibilityState === "visible") void recheck(true);
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [opened, recheck]);

  return (
    <>
      <Title i={1}>Будьте на связи</Title>
      <Sub i={2}>Подпишитесь на наш канал — там новости, акции и статус серверов.</Sub>
      <div key={shake} className={shake ? "blin-onb-shake" : undefined}>
        <div
          className="blin-onb-item blin-press"
          onClick={openChannel}
          role="button"
          tabIndex={0}
          style={{
            ["--i" as string]: 3,
            ...glassCard,
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "14px 16px",
            cursor: "pointer",
            borderColor: err ? "rgba(255, 92, 92, 0.45)" : T.borderStrong,
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <span
            style={{
              flex: "none",
              width: 50,
              height: 50,
              borderRadius: 16,
              background: "radial-gradient(circle at 50% 40%, #2E241B 0%, #17120E 100%)",
              border: `1px solid rgba(255, 107, 26, 0.35)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            <img src="/assets/logo.png" alt="" width={34} height={34} style={{ width: 34, height: 34, objectFit: "contain" }} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 17, fontWeight: 600, color: T.text }}>
              BlinVPN
              <MSIcon name="verified" style={{ fontSize: 17, color: T.orange, fontVariationSettings: "'FILL' 1" }} />
            </span>
            <span style={{ display: "block", fontSize: 14, color: T.textMuted, marginTop: 2 }}>{handle} · новости и статус</span>
          </span>
          <MSIcon name="arrow_outward" style={{ fontSize: 22, color: T.orangeBright }} />
        </div>
      </div>
      <div style={{ height: 16 }} />
      {/* виджет открывает канал; кнопка — только проверка (после возврата из канала она и так идёт сама) */}
      <PrimaryButton i={4} disabled={checking} onClick={() => void recheck()}>
        {checking ? <Spinner /> : null}
        {checking ? "Проверяем…" : "Я подписался"}
      </PrimaryButton>
      {err ? <div style={{ fontSize: 13, color: T.danger, marginTop: 10, textAlign: "center", animation: "blinvpnFadeIn 0.25s ease both" }}>{err}</div> : null}
    </>
  );
}

