import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { activateTrial, fetchConfig, fetchMe, fetchSupport } from "../utils/api";
import { formatDateRu } from "../utils/date";
import { Btn, MSIcon, T, btnReset, pageFrame, pageOuter } from "../components/ui";

type SubscriptionState =
  | "active"
  | "never"
  | "expired"
  | "expiring_soon"
  | "had_before"
  | "blocked";

interface StateConfig {
  statusTitle: string;
  statusTone: "ok" | "warn" | "off" | "danger";
  statusSubtitle: string;
  ctaLabel: string;
  ctaPath: string;
  ctaPrice: string;
  ctaPrimary: boolean;
}

// покупка → устройства + оплата → лист настройки
const BUY_PATH = `/payment?return=${encodeURIComponent("/subscription?setup=1")}`;

const STATE_CONFIGS: Record<SubscriptionState, StateConfig> = {
  active: {
    statusTitle: "Подписка активна",
    statusTone: "ok",
    statusSubtitle: "",
    ctaLabel: "Управление подпиской",
    ctaPath: "/subscription",
    ctaPrice: "от 99 ₽",
    ctaPrimary: false,
  },
  never: {
    statusTitle: "Нет подписки",
    statusTone: "off",
    statusSubtitle: "И никогда не было",
    ctaLabel: "Попробовать бесплатно",
    ctaPath: "/subscription?setup=1",
    ctaPrice: "0 ₽",
    ctaPrimary: true,
  },
  expired: {
    statusTitle: "Истекла",
    statusTone: "off",
    statusSubtitle: "Продлите, чтобы снова подключиться",
    ctaLabel: "Продлить подписку",
    ctaPath: "/subscription/extend",
    ctaPrice: "от 99 ₽",
    ctaPrimary: true,
  },
  expiring_soon: {
    statusTitle: "Скоро закончится",
    statusTone: "warn",
    statusSubtitle: "",
    ctaLabel: "Управление подпиской",
    ctaPath: "/subscription",
    ctaPrice: "от 99 ₽",
    ctaPrimary: false,
  },
  blocked: {
    statusTitle: "Заблокирована",
    statusTone: "danger",
    statusSubtitle: "Обратитесь в поддержку",
    ctaLabel: "Управление подпиской",
    ctaPath: "/subscription",
    ctaPrice: "от 99 ₽",
    ctaPrimary: false,
  },
  had_before: {
    statusTitle: "Нет подписки",
    statusTone: "off",
    statusSubtitle: "Пора её приобрести",
    ctaLabel: "Купить подписку",
    ctaPath: BUY_PATH,
    ctaPrice: "от 99 ₽",
    ctaPrimary: true,
  },
};

// цвет заголовка статуса по тону
const TONE: Record<StateConfig["statusTone"], string> = {
  ok: T.orange,
  warn: "#FFB587",
  off: T.text,
  danger: T.danger,
};

// «остался 1 день» / «осталось N дня|дней»
function daysLeftTitle(n: number): string {
  if (n <= 0) return "Заканчивается сегодня";
  const a = n % 100;
  const b = n % 10;
  if (b === 1 && a !== 11) return `Остался ${n} день`;
  if (b >= 2 && b <= 4 && (a < 12 || a > 14)) return `Осталось ${n} дня`;
  return `Осталось ${n} дней`;
}

function ActionTile({
  icon,
  label,
  onClick,
  disabled,
  delay,
  badge,
  animate,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  delay: number;
  badge?: number;
  animate: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="blin-press"
      style={{
        ...btnReset,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 18,
        minHeight: 92,
        padding: "16px 16px 14px",
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: T.radius.xl,
        cursor: disabled ? "not-allowed" : "pointer",
        animation: animate ? `blinvpnRise 0.85s var(--ease-out) ${delay}s both` : undefined,
        opacity: animate ? undefined : 1,
        position: "relative",
      }}
    >
      {badge ? (
        <span style={{
          position: "absolute", top: 12, right: 12, minWidth: 20, height: 20, padding: "0 6px", borderRadius: 10,
          background: T.orange, color: "#fff", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center",
        }}>{badge > 9 ? "9+" : badge}</span>
      ) : null}
      <span
        style={{
          width: 36,
          height: 36,
          borderRadius: 12,
          background: disabled ? "rgba(255,248,240,0.05)" : T.orangeSoft,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <MSIcon name={icon} style={{ color: disabled ? T.textDim : T.orange, fontSize: 20 }} />
      </span>
      <span style={{ fontWeight: 600, fontSize: 15, color: disabled ? T.textDim : T.text, letterSpacing: "-0.01em" }}>
        {label}
      </span>
    </button>
  );
}

const HOME_INTRO_KEY = "blin-home-intro-done";

function homeIntroPending(): boolean {
  try {
    return sessionStorage.getItem(HOME_INTRO_KEY) !== "1";
  } catch {
    return true;
  }
}

function markHomeIntroDone(): void {
  try {
    sessionStorage.setItem(HOME_INTRO_KEY, "1");
  } catch { /* private mode */ }
}

export default function BlinVPNApp() {
  const navigate = useNavigate();
  // интро только при входе / перезагрузке, не при «назад»
  const playIntro = useRef(homeIntroPending()).current;
  // данные пришли → layout готов к reveal
  const [dataReady, setDataReady] = useState(false);
  // при возврате назад UI сразу, без сплэша
  const [showUi, setShowUi] = useState(!playIntro);
  // дольше 3 с без данных — подпись снизу (только на интро)
  const [slow, setSlow] = useState(false);
  const startedAt = useRef(typeof performance !== "undefined" ? performance.now() : Date.now());
  const [subscriptionState, setSubscriptionState] = useState<SubscriptionState>("never");
  const [subscriptionUntilText, setSubscriptionUntilText] = useState("");
  const [trialEnabled, setTrialEnabled] = useState(true);
  const [trialBusy, setTrialBusy] = useState(false);
  // непрочитанные ответы поддержки → бейдж на плитке
  const [supportUnread, setSupportUnread] = useState(0);
  useEffect(() => {
    fetchSupport(1e12).then((st) => setSupportUnread(st.chat?.unread || 0)).catch(() => { /* нет чата */ });
  }, []);
  const [expiringTitle, setExpiringTitle] = useState("Скоро закончится");
  // чёрный список: заблокирован + только поддержка
  const [blacklisted, setBlacklisted] = useState(false);

  useEffect(() => {
    if (!playIntro) return;
    const t = window.setTimeout(() => setSlow(true), 3000);
    return () => window.clearTimeout(t);
  }, [playIntro]);

  // минимум держим сплэш, чтобы анимация не дёргалась при быстрой загрузке
  const MIN_SPLASH_MS = 1400;
  useEffect(() => {
    if (!dataReady) return;
    if (!playIntro) {
      setShowUi(true);
      return;
    }
    const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt.current;
    const wait = Math.max(0, MIN_SPLASH_MS - elapsed);
    const t = window.setTimeout(() => {
      requestAnimationFrame(() => {
        setShowUi(true);
        markHomeIntroDone();
      });
    }, wait);
    return () => window.clearTimeout(t);
  }, [dataReady, playIntro]);

  const cfg = STATE_CONFIGS[subscriptionState];
  const statusTitle = subscriptionState === "expiring_soon" ? expiringTitle : cfg.statusTitle;
  const tone = TONE[cfg.statusTone];
  const blocked = subscriptionState === "blocked";
  const trialOff = subscriptionState === "never" && !trialEnabled;
  const ctaLabel = trialOff ? "Оформить подписку" : cfg.ctaLabel;
  const ctaPath = trialOff ? BUY_PATH : cfg.ctaPath;
  const isTrialCta = subscriptionState === "never" && trialEnabled;
  const ctaPrimary = trialOff ? true : cfg.ctaPrimary;
  const glowOn = subscriptionState === "active" || subscriptionState === "expiring_soon";
  const glowDim = subscriptionState === "never" || subscriptionState === "had_before";
  const ease = playIntro ? "cubic-bezier(0.33, 1, 0.32, 1)" : "linear";
  const tAmb = playIntro ? `opacity 1.4s ${ease} 0.35s` : "none";
  const tGlow = playIntro ? `opacity 1.5s ${ease} 0.45s` : "none";
  const tBottom = playIntro ? `max-height 1.35s ${ease}, opacity 1s ${ease} 0.2s` : "none";
  const rise = (delay: number) => (playIntro && showUi ? `blinvpnRise 0.85s var(--ease-out) ${delay}s both` : undefined);

  const handleCta = async () => {
    if (blocked) return;
    if (isTrialCta) {
      setTrialBusy(true);
      const res = await activateTrial();
      setTrialBusy(false);
      if (!res.success && res.message) {
        navigate(BUY_PATH);
        return;
      }
    }
    navigate(ctaPath);
  };

  useEffect(() => {
    void (async () => {
      try {
        try {
          const conf = await fetchConfig();
          if (conf && typeof conf.trialEnabled === "boolean") setTrialEnabled(conf.trialEnabled);
        } catch { /* defaults */ }
        try {
          const me = await fetchMe();
          if (!me) return;
          const st = String(me.subscription_status || "");
          const until = String(me.subscription_until || "");
          if (until) setSubscriptionUntilText(formatDateRu(until));
          // key or account ban → same «заблокирована» state
          if (st === "blocked" || st === "banned") {
            setSubscriptionState("blocked");
            setBlacklisted(!!me.blacklisted);
          } else if (st === "active" || st === "trial") {
            const daysLeft = until
              ? Math.ceil((new Date(until).getTime() - Date.now()) / 86_400_000)
              : Infinity;
            if (daysLeft <= 3) {
              setExpiringTitle(
                daysLeftTitle(daysLeft),
              );
              setSubscriptionState("expiring_soon");
            } else {
              setSubscriptionState("active");
            }
          } else if (st === "expired") {
            setSubscriptionState("expired");
          } else if (st === "lapsed") {
            setSubscriptionState("had_before");
          } else {
            setSubscriptionState("never");
          }
        } catch { /* safe default */ }
      } finally {
        setDataReady(true);
      }
    })();
  }, []);

  const subtitle =
    subscriptionUntilText && (subscriptionState === "active" || subscriptionState === "expiring_soon")
      ? `до ${subscriptionUntilText}`
      : blacklisted
        ? "Вы в черном списке проекта"
        : cfg.statusSubtitle;

  return (
    <div style={pageOuter()}>
      <div style={pageFrame()}>
        <div
          className="blin-ambient"
          aria-hidden
          style={{
            opacity: showUi ? 1 : 0,
            transition: tAmb,
          }}
        />

        <div
          className="blin-tg-safe"
          style={{
            position: "relative",
            zIndex: 1,
            height: "100%",
            paddingLeft: 26,
            paddingRight: 26,
            // нижний отступ + индикатор home (tg fullscreen)
            paddingBottom: "calc(36px + var(--blin-tg-pad-bottom, 0px) / var(--blin-scale))",
            display: "flex",
            flexDirection: "column",
            boxSizing: "border-box",
          }}
        >
          {/* logo: при загрузке по центру экрана; после данных зона сжимается — логотип уезжает вверх */}
          <div
            style={{
              flex: "1 1 auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 0,
            }}
          >
            <div
              style={{
                position: "relative",
                width: "min(200px, 42vh)",
                height: "min(200px, 42vh)",
                maxWidth: 200,
                maxHeight: 200,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  inset: -12,
                  borderRadius: "50%",
                  background: `radial-gradient(circle, ${T.orangeGlow} 0%, transparent 68%)`,
                  opacity: showUi ? (glowDim ? 0.45 : 1) : 0,
                  transition: tGlow,
                  animation: showUi && glowOn
                    ? `blinvpnBreathe 4.5s ease-in-out ${playIntro ? "1.2s" : "0s"} infinite`
                    : undefined,
                }}
              />
              <img
                src="/assets/logo.png"
                width={200}
                height={200}
                alt="BlinVPN"
                draggable={false}
                style={{
                  position: "relative",
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                  userSelect: "none",
                }}
              />
            </div>
          </div>

          {/* низ: появляется после данных, сдвигая логотип на место */}
          <div
            style={{
              flexShrink: 0,
              maxHeight: showUi ? 520 : 0,
              opacity: showUi ? 1 : 0,
              overflow: "hidden",
              transition: tBottom,
              pointerEvents: showUi ? "auto" : "none",
            }}
          >
            <div
              style={{
                marginBottom: 14,
                animation: rise(0.28),
              }}
            >
              <div
                style={{
                  fontWeight: 700,
                  fontSize: 20,
                  lineHeight: 1.2,
                  letterSpacing: "-0.02em",
                  color: tone,
                  marginBottom: 3,
                }}
              >
                {statusTitle}
              </div>
              {subtitle ? (
                <div style={{ fontSize: 13, color: T.textMuted, fontWeight: 500, lineHeight: 1.35 }}>
                  {subtitle}
                </div>
              ) : null}
            </div>

            <div style={{ animation: rise(0.4), marginBottom: 10 }}>
              <Btn
                variant={ctaPrimary ? "primary" : "secondary"}
                disabled={blocked || trialBusy}
                onClick={() => { if (!blocked && !trialBusy) void handleCta(); }}
                style={{
                  justifyContent: "flex-start",
                  padding: "0 18px",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <MSIcon name={ctaPrimary ? "bolt" : "tune"} style={{ fontSize: 22, color: "inherit" }} />
                  <span>{trialBusy ? "Активация…" : ctaLabel}</span>
                </span>
              </Btn>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
              }}
            >
              <ActionTile
                icon="group"
                label="Друзья"
                disabled={blocked}
                delay={0.48}
                animate={playIntro && showUi}
                onClick={() => { if (!blocked) navigate("/referral"); }}
              />
              <ActionTile
                icon="redeem"
                label="Промокод"
                disabled={blocked}
                delay={0.56}
                animate={playIntro && showUi}
                onClick={() => { if (!blocked) navigate("/promocode"); }}
              />
              <ActionTile
                icon="settings"
                label="Настройки"
                disabled={blocked}
                delay={0.64}
                animate={playIntro && showUi}
                onClick={() => { if (!blocked) navigate("/settings"); }}
              />
              <ActionTile
                icon="chat"
                label="Поддержка"
                delay={0.72}
                animate={playIntro && showUi}
                disabled={blacklisted}
                badge={supportUnread}
                onClick={() => { if (!blacklisted) navigate("/support"); }}
              />
            </div>
          </div>

          {/* если данные идут дольше 3 с — только на интро входа */}
          {playIntro && !dataReady && slow ? (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(28px + var(--blin-tg-pad-bottom, 0px) / var(--blin-scale))",
                textAlign: "center",
                fontSize: 14,
                fontWeight: 500,
                color: T.textMuted,
                letterSpacing: "0.02em",
                animation: "blinvpnFadeIn 0.6s ease both",
                pointerEvents: "none",
              }}
            >
              Загрузка...
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
