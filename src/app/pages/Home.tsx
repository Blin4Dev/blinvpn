import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { activateTrial, applyDiscount, fetchConfig, fetchDiscount, fetchMe, fetchPlans, minPlanPrice } from "../utils/api";
import { LoadingScreen } from "../components/ui";

// SVG-иконки
const ShoppingBagIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/>
    <line x1="3" y1="6" x2="21" y2="6"/>
    <path d="M16 10a4 4 0 01-8 0"/>
  </svg>
);

const UsersIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 00-3-3.87"/>
    <path d="M16 3.13a4 4 0 010 7.75"/>
  </svg>
);

const GiftIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 12 20 22 4 22 4 12"/>
    <rect x="2" y="7" width="20" height="5"/>
    <line x1="12" y1="22" x2="12" y2="7"/>
    <path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z"/>
    <path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z"/>
  </svg>
);

const SettingsIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
  </svg>
);

// Логотип BlinVPN (PNG)
const BlinVPNLogo = () => (
  <img
    src="/assets/logo.png"
    width={220}
    height={220}
    alt="BlinVPN"
    draggable={false}
    style={{ width: "100%", height: "100%" }}
  />
);

// ─────────────────────────────────────────────
// Тип состояния подписки
// ─────────────────────────────────────────────
type SubscriptionState =
  | "active"          // Подписка активна
  | "never"           // Нет подписки, никогда не было
  | "expired"         // Закончилась
  | "expiring_soon"   // Осталось ≤ 3 дней
  | "had_before"      // Нет подписки, но раньше была
  | "blocked";        // Ключ заблокирован

// ─────────────────────────────────────────────
// Конфигурация по состояниям
// ─────────────────────────────────────────────
interface StateConfig {
  statusTitle: string;
  statusTitleColor: string;
  statusSubtitle: string;
  statusSubtitleOpacity?: number;
  ctaBg: string;
  ctaLabel: string;
  ctaPath: string;
  ctaPrice: string;
  glowFilter: string;
}

const STATE_CONFIGS: Record<SubscriptionState, StateConfig> = {
  // ── 1. Активная подписка (оригинальное состояние) ───────────────────────
  active: {
    statusTitle: "Подписка активна",
    statusTitleColor: "#FF6E00",
    statusSubtitle: "",
    ctaBg: "#333333",
    ctaLabel: "Управление подпиской",
    ctaPath: "/subscription",
    ctaPrice: "от 99 ₽",
    glowFilter: [
      "drop-shadow(0px 0px 56px rgba(254, 144, 42, 0.92))",
      "drop-shadow(0px 0px 112px rgba(254, 144, 42, 0.92))",
      "drop-shadow(0px 0px 37px rgba(254, 144, 42, 0.92))",
      "drop-shadow(0px 0px 18px rgba(254, 144, 42, 0.92))",
    ].join(" "),
  },

  // ── 2. Нет подписки (никогда не было) ───────────────────────────────────
  // Макет 1 / CSS-док 2
  never: {
    statusTitle: "Нет подписки",
    statusTitleColor: "#FFFFFF",
    statusSubtitle: "и никогда не было",
    statusSubtitleOpacity: 0.5,
    ctaBg: "rgba(241, 135, 38, 0.8)",
    ctaLabel: "Попробовать бесплатно",
    ctaPath: "/subscription/start?step=1&flow=trial&trialUsed=0",
    ctaPrice: "0 ₽",
    // Едва заметное свечение (примерно в 5–6 раз слабее, чем в active)
    glowFilter: [
      "drop-shadow(0px 0px 18px rgba(241, 135, 38, 0.20))",
      "drop-shadow(0px 0px 10px rgba(241, 135, 38, 0.17))",
      "drop-shadow(0px 0px 6px rgba(241, 135, 38, 0.14))",
      "drop-shadow(0px 0px 3px rgba(241, 135, 38, 0.11))",
      "drop-shadow(0px 0px 1.4px rgba(241, 135, 38, 0.10))",
      "drop-shadow(0px 0px 0.8px rgba(241, 135, 38, 0.09))",
    ].join(" "),
  },

  // ── 3. Подписка закончилась ─────────────────────────────────────────────
  // Макет 2 / CSS-док 3
  expired: {
    statusTitle: "Закончилась",
    statusTitleColor: "#FFD7B2",
    statusSubtitle: "",
    ctaBg: "#333333",
    ctaLabel: "Продлить подписку",
    ctaPath: "/subscription/extend",
    ctaPrice: "от 99 ₽",
    // Чуть сильнее, чем в never
    glowFilter: [
      "drop-shadow(0px 0px 26px rgba(241, 135, 38, 0.28))",
      "drop-shadow(0px 0px 14px rgba(241, 135, 38, 0.24))",
      "drop-shadow(0px 0px 8px rgba(241, 135, 38, 0.20))",
      "drop-shadow(0px 0px 4px rgba(241, 135, 38, 0.15))",
      "drop-shadow(0px 0px 1.8px rgba(241, 135, 38, 0.13))",
      "drop-shadow(0px 0px 1px rgba(241, 135, 38, 0.11))",
    ].join(" "),
  },

  // ── 4. Скоро закончится (≤ 3 дней) ──────────────────────────────────────
  // Макет 3 / CSS-док 4
  expiring_soon: {
    statusTitle: "Осталось 3 дня",
    statusTitleColor: "#FF6E00",
    statusSubtitle: "",
    ctaBg: "#333333",
    ctaLabel: "Управление подпиской",
    ctaPath: "/subscription",
    ctaPrice: "от 99 ₽",
    // Чуть меньше, чем в active
    glowFilter: [
      "drop-shadow(0px 0px 42px rgba(237, 140, 49, 0.74))",
      "drop-shadow(0px 0px 84px rgba(237, 140, 49, 0.74))",
      "drop-shadow(0px 0px 28px rgba(237, 140, 49, 0.74))",
      "drop-shadow(0px 0px 14px rgba(237, 140, 49, 0.74))",
      "drop-shadow(0px 0px 4px rgba(237, 140, 49, 0.74))",
      "drop-shadow(0px 0px 2px rgba(237, 140, 49, 0.74))",
    ].join(" "),
  },

  // ── 6. Ключ заблокирован ────────────────────────────────────────────────
  blocked: {
    statusTitle: "Заблокирована",
    statusTitleColor: "#FF4D4D",
    statusSubtitle: "Обратитесь в поддержку",
    statusSubtitleOpacity: 0.6,
    ctaBg: "#333333",
    ctaLabel: "Управление подпиской",
    ctaPath: "/subscription",
    ctaPrice: "от 99 ₽",
    glowFilter: [
      "drop-shadow(0px 0px 26px rgba(255, 77, 77, 0.22))",
      "drop-shadow(0px 0px 12px rgba(255, 77, 77, 0.16))",
      "drop-shadow(0px 0px 5px rgba(255, 77, 77, 0.12))",
    ].join(" "),
  },

  // ── 5. Раньше была подписка, сейчас нет ─────────────────────────────────
  // Макет 4 / CSS-док 5
  had_before: {
    statusTitle: "Нет подписки",
    statusTitleColor: "#FFFFFF",
    statusSubtitle: "",
    ctaBg: "rgba(241, 135, 38, 0.8)",
    ctaLabel: "Купить подписку",
    ctaPath: "/subscription/start?step=1&flow=purchase&trialUsed=1",
    ctaPrice: "от 99 ₽",
    // Так же, как в never
    glowFilter: [
      "drop-shadow(0px 0px 18px rgba(241, 135, 38, 0.20))",
      "drop-shadow(0px 0px 10px rgba(241, 135, 38, 0.17))",
      "drop-shadow(0px 0px 6px rgba(241, 135, 38, 0.14))",
      "drop-shadow(0px 0px 3px rgba(241, 135, 38, 0.11))",
      "drop-shadow(0px 0px 1.4px rgba(241, 135, 38, 0.10))",
      "drop-shadow(0px 0px 0.8px rgba(241, 135, 38, 0.09))",
    ].join(" "),
  },
};

// ─────────────────────────────────────────────
// Основной компонент
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// Статичные стили (не зависят от состояния)
// ─────────────────────────────────────────────
const S = {
  wrapper: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    minHeight: "100vh",
    background: "#111",
    fontFamily: "'Inter', sans-serif",
  } as React.CSSProperties,
  greetingName: {
    color: "#FF6E00",
  } as React.CSSProperties,
  btnHalf: {
    width: "173px",
    height: "50px",
    background: "#333333",
    borderRadius: "30px",
    display: "flex",
    alignItems: "center",
    paddingLeft: "18px",
    gap: "10px",
    cursor: "pointer",
    border: "none",
  } as React.CSSProperties,
  btnLabel: {
    fontWeight: 600,
    fontSize: "17px",
    color: "#FFFFFF",
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  btnLabelSm: {
    fontWeight: 600,
    fontSize: "16px",
    color: "#FFFFFF",
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  btnPrice: {
    marginLeft: "auto",
    fontWeight: 500,
    fontSize: "17px",
    color: "rgba(255,255,255,0.7)",
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  rowPair: {
    display: "flex",
    gap: "4px",
  } as React.CSSProperties,
};

export default function BlinVPNApp() {
  const navigate = useNavigate();
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [subscriptionState, setSubscriptionState] = useState<SubscriptionState>("never");
  const [subscriptionUntilText, setSubscriptionUntilText] = useState("нет данных");
  const [minPrice, setMinPrice] = useState(99);
  const [discount, setDiscount] = useState(0);
  const [trialEnabled, setTrialEnabled] = useState(true);
  const [trialBusy, setTrialBusy] = useState(false);

  const cfg = STATE_CONFIGS[subscriptionState];
  const blocked = subscriptionState === "blocked";
  // Если админ выключил пробный период — в состоянии «никогда не было» ведём сразу к покупке.
  const trialOff = subscriptionState === "never" && !trialEnabled;
  const ctaLabel = trialOff ? "Оформить подписку" : cfg.ctaLabel;
  const ctaPath = trialOff ? "/subscription/start?step=1&flow=purchase&trialUsed=1" : cfg.ctaPath;
  const isTrialCta = subscriptionState === "never" && trialEnabled;
  const isFree = !trialOff && cfg.ctaPrice === "0 ₽";
  const hasDiscount = discount > 0 && !isFree && !blocked;
  const discountedMin = applyDiscount(minPrice, discount);
  const ctaPrice = isFree ? cfg.ctaPrice : `от ${discountedMin} ₽`;

  const handleCta = async () => {
    if (blocked) return;
    if (isTrialCta) {
      // Активируем пробный период, затем ведём в онбординг установки.
      setTrialBusy(true);
      const res = await activateTrial();
      setTrialBusy(false);
      if (!res.success && res.message) {
        // Уже брал пробный или он выключен — отправляем к покупке.
        navigate("/subscription/start?step=1&flow=purchase&trialUsed=1");
        return;
      }
    }
    navigate(ctaPath);
  };
  const ctaPriceBase = `от ${minPrice} ₽`;

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    void (async () => {
     try {
      try {
        const plans = await fetchPlans();
        setMinPrice(minPlanPrice(plans.plans));
      } catch {
        /* keep default 99 */
      }
      try {
        const d = await fetchDiscount();
        if (d.active && d.percent > 0) setDiscount(d.percent);
      } catch {
        /* без скидки */
      }
      try {
        const conf = await fetchConfig();
        if (conf && typeof conf.trialEnabled === "boolean") setTrialEnabled(conf.trialEnabled);
      } catch {
        /* по умолчанию пробный включён */
      }
      try {
        const me = await fetchMe();
        if (!me) return;
        const st = String(me.subscription_status || "");
        const until = String(me.subscription_until || "");
        if (until) {
          setSubscriptionUntilText(until.slice(0, 10));
        }
        if (st === "blocked") {
          setSubscriptionState("blocked");
        } else if (st === "active" || st === "trial") {
          // Если осталось ≤ 3 дней — показываем предупреждение.
          const daysLeft = until
            ? Math.ceil((new Date(until).getTime() - Date.now()) / 86_400_000)
            : Infinity;
          setSubscriptionState(daysLeft <= 3 ? "expiring_soon" : "active");
        } else if (st === "expired") {
          setSubscriptionState("expired");
        } else if (st === "lapsed") {
          setSubscriptionState("had_before");
        } else {
          setSubscriptionState("never");
        }
      } catch {
        // Если API недоступно, показываем безопасный дефолт "нет подписки".
      }
     } finally {
        setLoading(false);
     }
    })();
  }, []);

  const styles: {
    phone: React.CSSProperties;
    greeting: React.CSSProperties;
    notifBtn: React.CSSProperties;
    logoWrapper: React.CSSProperties;
    subSection: React.CSSProperties;
    subActive: React.CSSProperties;
    subDate: React.CSSProperties;
    clockBtn: React.CSSProperties;
    btnRow: (top: number, delay: number) => React.CSSProperties;
    btnFull: React.CSSProperties;
  } = {
    phone: {
      position: "relative",
      width: "402px",
      height: "803px",
      background: "#212121",
      borderRadius: "40px",
      overflow: "hidden",
      boxShadow: "0 30px 80px rgba(0,0,0,0.7)",
      opacity: visible ? 1 : 0,
      transform: visible ? "translateY(0) scale(1)" : "translateY(30px) scale(0.96)",
      transition: "opacity 0.6s ease, transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)",
    },

    // Шапка
    greeting: {
      position: "absolute",
      left: "26px",
      top: "26px",
      fontWeight: 500,
      fontSize: "30px",
      lineHeight: "36px",
      color: "#FFFFFF",
      opacity: visible ? 1 : 0,
      transform: visible ? "translateX(0)" : "translateX(-20px)",
      transition: "opacity 0.5s ease 0.2s, transform 0.5s ease 0.2s",
    },
    notifBtn: {
      position: "absolute",
      width: "36px",
      height: "36px",
      right: "26px",
      top: "26px",
      background: "#313131",
      borderRadius: "6px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      opacity: visible ? 1 : 0,
      transform: visible ? "scale(1)" : "scale(0.7)",
      transition: "opacity 0.5s ease 0.3s, transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 0.3s",
    },

    // Логотип
    logoWrapper: {
      position: "absolute",
      width: "346px",
      height: "346px",
      left: "28px",
      top: "68px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      filter: cfg.glowFilter,
      opacity: visible ? 1 : 0,
      transform: visible ? "scale(1)" : "scale(0.8)",
      transition: "opacity 0.7s ease 0.15s, transform 0.7s cubic-bezier(0.34, 1.56, 0.64, 1) 0.15s, filter 0.5s ease",
    },

    // Информация о подписке
    subSection: {
      position: "absolute",
      left: "26px",
      top: "478px",
      opacity: visible ? 1 : 0,
      transform: visible ? "translateY(0)" : "translateY(15px)",
      transition: "opacity 0.5s ease 0.35s, transform 0.5s ease 0.35s",
    },
    subActive: {
      fontWeight: 600,
      fontSize: "27px",
      lineHeight: "33px",
      color: cfg.statusTitleColor,
    },
    subDate: {
      fontWeight: 500,
      fontSize: "16px",
      lineHeight: "19px",
      color: "#FFFFFF",
      opacity: cfg.statusSubtitleOpacity ?? 1,
      marginTop: "2px",
    },
    clockBtn: {
      position: "absolute",
      width: "52px",
      height: "52px",
      right: "26px",
      top: "478px",
      background: "#313131",
      borderRadius: "15px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      opacity: visible ? 1 : 0,
      transform: visible ? "scale(1)" : "scale(0.7)",
      transition: "opacity 0.5s ease 0.4s, transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 0.4s",
      cursor: "pointer",
      border: "none",
    },

    // Кнопки
    btnRow: (top: number, delay: number) => ({
      position: "absolute",
      left: "26px",
      top: `${top}px`,
      opacity: visible ? 1 : 0,
      transform: visible ? "translateY(0)" : "translateY(12px)",
      transition: `opacity 0.45s ease ${delay}s, transform 0.45s ease ${delay}s`,
    }),
    btnFull: {
      width: "350px",
      height: "50px",
      background: cfg.ctaBg,
      borderRadius: "30px",
      border: "none",
      display: "flex",
      alignItems: "center",
      paddingLeft: "18px",
      paddingRight: "18px",
      gap: "12px",
      cursor: "pointer",
    },
  };

  if (loading) return <LoadingScreen />;

  return (
    <div style={S.wrapper}>
      <div style={styles.phone}>
        {/* Тёплое фоновое свечение */}
        <div style={{
          position: "absolute",
          width: "346px",
          height: "346px",
          left: "28px",
          top: "68px",
          background: "radial-gradient(ellipse at center, rgba(254,144,42,0.22) 0%, transparent 70%)",
          borderRadius: "50%",
          pointerEvents: "none",
        }} />

        {/* Логотип */}
        <div style={styles.logoWrapper}>
          <BlinVPNLogo />
        </div>

        {/* Статус подписки */}
        <div style={styles.subSection}>
          <div style={styles.subActive}>{cfg.statusTitle}</div>
          <div style={styles.subDate}>{subscriptionUntilText === "нет данных" ? cfg.statusSubtitle : `до ${subscriptionUntilText}`}</div>
        </div>
        <button
          type="button"
          style={{ ...styles.clockBtn, opacity: blocked ? 0.4 : styles.clockBtn.opacity, cursor: blocked ? "not-allowed" : "pointer" }}
          onClick={() => { if (!blocked) navigate("/settings"); }}
          disabled={blocked}
          aria-label="Настройки"
        >
          <SettingsIcon />
        </button>

        {/* Основная кнопка */}
        <div style={styles.btnRow(550, 0.45)}>
          <button
            type="button"
            style={{ ...styles.btnFull, opacity: blocked || trialBusy ? 0.4 : 1, cursor: blocked ? "not-allowed" : "pointer" }}
            onClick={() => { if (!blocked && !trialBusy) void handleCta(); }}
            disabled={blocked || trialBusy}
          >
            <ShoppingBagIcon />
            <span style={S.btnLabel}>{trialBusy ? "Активация…" : ctaLabel}</span>
            <span style={{ ...S.btnPrice, display: "flex", alignItems: "baseline", gap: "6px" }}>
              {hasDiscount && (
                <span style={{ opacity: 0.4, textDecoration: "line-through" }}>{ctaPriceBase}</span>
              )}
              <span>{ctaPrice}</span>
            </span>
          </button>
        </div>

        {/* Друзья + промокоды */}
        <div style={styles.btnRow(608, 0.5)}>
          <div style={S.rowPair}>
            <button
              type="button"
              style={{ ...S.btnHalf, opacity: blocked ? 0.4 : 1, cursor: blocked ? "not-allowed" : "pointer" }}
              onClick={() => { if (!blocked) navigate("/referral"); }}
              disabled={blocked}
            >
              <UsersIcon />
              <span style={S.btnLabelSm}>Друзья</span>
            </button>
            <button
              type="button"
              style={{ ...S.btnHalf, opacity: blocked ? 0.4 : 1, cursor: blocked ? "not-allowed" : "pointer" }}
              onClick={() => { if (!blocked) navigate("/promocode"); }}
              disabled={blocked}
            >
              <GiftIcon />
              <span style={S.btnLabelSm}>Промокоды</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}