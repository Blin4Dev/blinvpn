import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { activateTrial, applyDiscount, fetchConfig, fetchDiscount, fetchMe, fetchPlans, minPlanPrice } from "../utils/api";
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
    statusSubtitle: "Попробуйте бесплатно — займёт минуту",
    ctaLabel: "Попробовать бесплатно",
    ctaPath: "/subscription/start?step=1&flow=trial&trialUsed=0",
    ctaPrice: "0 ₽",
    ctaPrimary: true,
  },
  expired: {
    statusTitle: "Подписка закончилась",
    statusTone: "warn",
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
    statusSubtitle: "Оформите снова — всё на месте",
    ctaLabel: "Купить подписку",
    ctaPath: "/subscription/start?step=1&flow=purchase&trialUsed=1",
    ctaPrice: "от 99 ₽",
    ctaPrimary: true,
  },
};

const TONE: Record<StateConfig["statusTone"], { dot: string; bg: string; text: string }> = {
  ok: { dot: T.orange, bg: T.orangeSoft, text: T.orangeBright },
  warn: { dot: "#FFB020", bg: "rgba(255,176,32,0.14)", text: "#FFC14D" },
  off: { dot: T.textDim, bg: "rgba(255,248,240,0.06)", text: T.textMuted },
  danger: { dot: T.danger, bg: T.dangerSoft, text: T.danger },
};

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
        opacity: disabled ? 0.4 : 1,
        animation: `blinvpnRise 0.5s var(--ease-out) ${delay}s both`,
      }}
    >
      <span
        style={{
          width: 36,
          height: 36,
          borderRadius: 12,
          background: T.orangeSoft,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <MSIcon name={icon} style={{ color: T.orange, fontSize: 20 }} />
      </span>
      <span style={{ fontWeight: 600, fontSize: 15, color: T.text, letterSpacing: "-0.01em" }}>
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
  const [minPrice, setMinPrice] = useState(99);
  const [discount, setDiscount] = useState(0);
  const [trialEnabled, setTrialEnabled] = useState(true);
  const [trialBusy, setTrialBusy] = useState(false);
  const [supportUrl, setSupportUrl] = useState("https://t.me/blinteams");
  const [expiringTitle, setExpiringTitle] = useState("Скоро закончится");

  const cfg = STATE_CONFIGS[subscriptionState];
  const statusTitle = subscriptionState === "expiring_soon" ? expiringTitle : cfg.statusTitle;
  const tone = TONE[cfg.statusTone];
  const blocked = subscriptionState === "blocked";
  const trialOff = subscriptionState === "never" && !trialEnabled;
  const ctaLabel = trialOff ? "Оформить подписку" : cfg.ctaLabel;
  const ctaPath = trialOff ? "/subscription/start?step=1&flow=purchase&trialUsed=1" : cfg.ctaPath;
  const isTrialCta = subscriptionState === "never" && trialEnabled;
  const isFree = !trialOff && cfg.ctaPrice === "0 ₽";
  const hasDiscount = discount > 0 && !isFree && !blocked;
  const discountedMin = applyDiscount(minPrice, discount);
  const ctaPrice = isFree ? cfg.ctaPrice : `от ${discountedMin} ₽`;
  const ctaPriceBase = `от ${minPrice} ₽`;
  const ctaPrimary = trialOff ? true : cfg.ctaPrimary;

  const handleCta = async () => {
    if (blocked) return;
    if (isTrialCta) {
      setTrialBusy(true);
      const res = await activateTrial();
      setTrialBusy(false);
      if (!res.success && res.message) {
        navigate("/subscription/start?step=1&flow=purchase&trialUsed=1");
        return;
      }
    }
    navigate(ctaPath);
  };

  useEffect(() => {
    void (async () => {
      try {
        try {
          const plans = await fetchPlans();
          setMinPrice(minPlanPrice(plans.plans));
        } catch { /* keep 99 */ }
        try {
          const d = await fetchDiscount();
          if (d.active && d.percent > 0) setDiscount(d.percent);
        } catch { /* no discount */ }
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
          if (until) setSubscriptionUntilText(until.slice(0, 10));
          if (st === "blocked") {
            setSubscriptionState("blocked");
          } else if (st === "active" || st === "trial") {
            const daysLeft = until
              ? Math.ceil((new Date(until).getTime() - Date.now()) / 86_400_000)
              : Infinity;
            if (daysLeft <= 3) {
              setExpiringTitle(
                daysLeft <= 0 ? "Заканчивается сегодня" : `Осталось ${daysLeft} дн.`,
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
      : cfg.statusSubtitle;

  return (
    <div style={pageOuter()}>
      <div style={pageFrame()}>
        <div className="blin-ambient" aria-hidden />

        <div
          style={{
            position: "relative",
            zIndex: 1,
            height: "100%",
            padding: "16px 26px 28px",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* История — справа сверху */}
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              animation: "blinvpnRise 0.45s var(--ease-out) both",
            }}
          >
            <button
              type="button"
              aria-label="История"
              disabled={blocked}
              onClick={() => { if (!blocked) navigate("/history"); }}
              className="blin-press"
              style={{
                ...btnReset,
                width: 44,
                height: 44,
                borderRadius: 14,
                background: T.surfaceRaised,
                border: `1px solid ${T.border}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: blocked ? "not-allowed" : "pointer",
                opacity: blocked ? 0.4 : 1,
              }}
            >
              <MSIcon name="history" style={{ color: T.text, fontSize: 22 }} />
            </button>
          </div>

          {/* Logo visual */}
          <div
            style={{
              flex: 1,
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
                width: 220,
                height: 220,
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
                  width: 200,
                  height: 200,
                  objectFit: "contain",
                  userSelect: "none",
                }}
              />
            </div>
          </div>

          {/* Status */}
          <div
            style={{
              marginBottom: 18,
              animation: "blinvpnRise 0.5s var(--ease-out) 0.12s both",
            }}
          >
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 12px 7px 10px",
                borderRadius: T.radius.pill,
                background: tone.bg,
                marginBottom: 10,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: tone.dot,
                  animation: cfg.statusTone === "ok" ? "blinvpnPulse 2.2s ease-in-out infinite" : undefined,
                }}
              />
              <span style={{ fontWeight: 600, fontSize: 13, color: tone.text }}>{statusTitle}</span>
            </div>
            {subtitle ? (
              <div style={{ fontSize: 14, color: T.textMuted, fontWeight: 500, lineHeight: 1.35 }}>
                {subtitle}
              </div>
            ) : null}
          </div>

          {/* Primary CTA */}
          <div style={{ animation: "blinvpnRise 0.5s var(--ease-out) 0.18s both", marginBottom: 12 }}>
            <Btn
              variant={ctaPrimary ? "primary" : "secondary"}
              disabled={blocked || trialBusy}
              onClick={() => { if (!blocked && !trialBusy) void handleCta(); }}
              style={{ justifyContent: "space-between", padding: "0 18px" }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <MSIcon name={ctaPrimary ? "bolt" : "tune"} style={{ fontSize: 22, color: "inherit" }} />
                <span>{trialBusy ? "Активация…" : ctaLabel}</span>
              </span>
              <span style={{ display: "flex", alignItems: "baseline", gap: 6, fontWeight: 600, opacity: 0.85 }}>
                {hasDiscount && (
                  <span style={{ opacity: 0.45, textDecoration: "line-through", fontSize: 13 }}>
                    {ctaPriceBase}
                  </span>
                )}
                <span style={{ fontSize: 15 }}>{ctaPrice}</span>
              </span>
            </Btn>
          </div>

          {/* Action grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
            }}
          >
            <ActionTile
              icon="group"
              label="Рефералы"
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
              disabled={blocked}
              delay={0.34}
              onClick={() => {
                if (!blocked) window.open(supportUrl, "_blank", "noopener,noreferrer");
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
