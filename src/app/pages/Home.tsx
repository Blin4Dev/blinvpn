import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { activateTrial, fetchConfig, fetchMe } from "../utils/api";
import { formatDateRu } from "../utils/date";
import { Btn, LoadingScreen, MSIcon, T, btnReset, pageFrame, pageOuter } from "../components/ui";

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

// Покупка: выбор устройств и оплата, после неё — окно «Добавить подписку»
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

// Цвет заголовка статуса: оранжевый — активна, светло-оранжевый — скоро
// закончится, белый — нет/истекла, красный — заблокирована.
const TONE: Record<StateConfig["statusTone"], string> = {
  ok: T.orange,
  warn: "#FFB587",
  off: T.text,
  danger: T.danger,
};

/** «Остался 1 день», «Осталось 2 дня», «Осталось 5 дней». */
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
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  delay: number;
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
        // Не opacity: анимация появления заканчивается на opacity 1 и перебивает её.
        // Неактивную плитку делаем серой через цвета.
        animation: `blinvpnRise 0.5s var(--ease-out) ${delay}s both`,
      }}
    >
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

export default function BlinVPNApp() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [subscriptionState, setSubscriptionState] = useState<SubscriptionState>("never");
  const [subscriptionUntilText, setSubscriptionUntilText] = useState("");
  const [trialEnabled, setTrialEnabled] = useState(true);
  const [trialBusy, setTrialBusy] = useState(false);
  const [supportUrl, setSupportUrl] = useState("https://t.me/blinteams");
  const [expiringTitle, setExpiringTitle] = useState("Скоро закончится");
  // Чёрный список: заблокирована и кнопка поддержки
  const [blacklisted, setBlacklisted] = useState(false);

  const cfg = STATE_CONFIGS[subscriptionState];
  const statusTitle = subscriptionState === "expiring_soon" ? expiringTitle : cfg.statusTitle;
  const tone = TONE[cfg.statusTone];
  const blocked = subscriptionState === "blocked";
  const trialOff = subscriptionState === "never" && !trialEnabled;
  const ctaLabel = trialOff ? "Оформить подписку" : cfg.ctaLabel;
  const ctaPath = trialOff ? BUY_PATH : cfg.ctaPath;
  const isTrialCta = subscriptionState === "never" && trialEnabled;
  const ctaPrimary = trialOff ? true : cfg.ctaPrimary;

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
          if (conf && typeof conf.supportUrl === "string" && conf.supportUrl) {
            setSupportUrl(conf.supportUrl as string);
          }
        } catch { /* defaults */ }
        try {
          const me = await fetchMe();
          if (!me) return;
          const st = String(me.subscription_status || "");
          const until = String(me.subscription_until || "");
          if (until) setSubscriptionUntilText(formatDateRu(until));
          // Заблокирован ключ или весь аккаунт — одно и то же состояние «Заблокирована»
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
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <LoadingScreen />;

  const subtitle =
    subscriptionUntilText && (subscriptionState === "active" || subscriptionState === "expiring_soon")
      ? `до ${subscriptionUntilText}`
      : blacklisted
        ? "Вы в черном списке проекта"
        : cfg.statusSubtitle;

  return (
    <div style={pageOuter()}>
      <div style={pageFrame()}>
        <div className="blin-ambient" aria-hidden />

        <div
          className="blin-tg-safe"
          style={{
            position: "relative",
            zIndex: 1,
            height: "100%",
            paddingLeft: 26,
            paddingRight: 26,
            // Воздух снизу + системная полоска «домой» (в Telegram fullscreen)
            paddingBottom: "calc(36px + var(--blin-tg-pad-bottom, 0px) / var(--blin-scale))",
            display: "flex",
            flexDirection: "column",
            boxSizing: "border-box",
          }}
        >
          {/* Logo — занимает свободное место по центру */}
          <div
            style={{
              flex: "1 1 auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 0,
              animation: "blinvpnRise 0.55s var(--ease-out) 0.06s both",
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
                  animation: subscriptionState === "active" || subscriptionState === "expiring_soon"
                    ? "blinvpnBreathe 4.5s ease-in-out infinite"
                    : undefined,
                  opacity: subscriptionState === "never" || subscriptionState === "had_before" ? 0.45 : 1,
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

          {/* Низ: статус + история + CTA + сетка */}
          <div style={{ flexShrink: 0 }}>
            <div
              style={{
                marginBottom: 14,
                animation: "blinvpnRise 0.5s var(--ease-out) 0.12s both",
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

            <div style={{ animation: "blinvpnRise 0.5s var(--ease-out) 0.18s both", marginBottom: 10 }}>
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
                delay={0.22}
                onClick={() => { if (!blocked) navigate("/referral"); }}
              />
              <ActionTile
                icon="redeem"
                label="Промокод"
                disabled={blocked}
                delay={0.26}
                onClick={() => { if (!blocked) navigate("/promocode"); }}
              />
              <ActionTile
                icon="settings"
                label="Настройки"
                disabled={blocked}
                delay={0.3}
                onClick={() => { if (!blocked) navigate("/settings"); }}
              />
              <ActionTile
                icon="chat"
                label="Поддержка"
                delay={0.34}
                disabled={blacklisted}
                onClick={() => { if (!blacklisted) window.open(supportUrl, "_blank", "noopener,noreferrer"); }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
