import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { BackCircleButton, MSIcon } from "../components/ui";
import { useAppError } from "../components/ErrorModal";
import { useSmartBack } from "../utils/navigation";
import {
  applyDiscount,
  createPayment,
  fetchConfig,
  fetchDiscount,
  fetchMe,
  fetchPlans,
  fetchQuote,
  openPayUrl,
  openStarsInvoice,
  plansToPriceMap,
  plansToStarsMap,
  type PaymentQuote,
} from "../utils/api";

const FALLBACK_OPTIONS = [1, 2, 3, 5];

type PaymentMethod = "sbp" | "card" | "tg_stars";

const METHODS: { id: PaymentMethod; label: string; icon: React.ReactNode }[] = [
  {
    id: "sbp",
    label: "СБП",
    icon: (
      <img
        src="https://i.imgur.com/pu9w7tE.png"
        alt=""
        style={{ width: 32, height: 33, objectFit: "contain" }}
      />
    ),
  },
  {
    id: "card",
    label: "Банковская карта",
    icon: (
      <MSIcon
        name="credit_card"
        style={{ fontSize: 32, color: "#E3E3E3", width: 32, height: 32 }}
      />
    ),
  },
  {
    id: "tg_stars",
    label: "Звёзды Telegram",
    icon: (
      <img
        src="https://i.imgur.com/Yu8PZ7N.png"
        alt=""
        style={{ width: 32, height: 32, objectFit: "contain" }}
      />
    ),
  },
];

export default function Payment() {
  const { showError } = useAppError();
  const goBack = useSmartBack("/");
  const navigate = useNavigate();

  const [searchParams] = useSearchParams();
  const initialDevices = Math.min(
    5,
    Math.max(1, parseInt(searchParams.get("devices") || "1", 10)),
  );
  const months = Math.max(1, parseInt(searchParams.get("months") || "1", 10));
  const flowType = searchParams.get("type");
  const subParam = searchParams.get("sub");
  const isDevicesFlow = flowType === "devices";
  const isTrafficReset = flowType === "traffic_reset";
  const purpose: "subscription" | "devices" | "traffic_reset" = isTrafficReset
    ? "traffic_reset"
    : isDevicesFlow
      ? "devices"
      : "subscription";
  const extraDevices = isDevicesFlow
    ? Math.max(0, parseInt(searchParams.get("count") || "0", 10))
    : 0;
  const [devices, setDevices] = useState<number>(initialDevices);
  const [deviceOptions, setDeviceOptions] = useState<number[]>(FALLBACK_OPTIONS);
  const [rubMap, setRubMap] = useState<Record<number, number>>({
    1: 99,
    2: 169,
    3: 229,
    5: 349,
  });
  const [starsMap, setStarsMap] = useState<Record<number, number>>({
    1: 99,
    2: 169,
    3: 229,
    5: 349,
  });
  const [method, setMethod] = useState<PaymentMethod>("sbp");
  const [saveCard, setSaveCard] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payInfo, setPayInfo] = useState("");
  const [discount, setDiscount] = useState(0);
  const [refBalance, setRefBalance] = useState(0);
  const [providerMin, setProviderMin] = useState<Record<string, number>>({ card: 50, sberpay: 50, sbp: 10 });
  const [useRef, setUseRef] = useState(false);
  const [quote, setQuote] = useState<PaymentQuote | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const data = await fetchPlans();
        const options =
          data.plans.length > 0
            ? data.plans.map((p) => p.devices).sort((a, b) => a - b)
            : FALLBACK_OPTIONS;
        setDeviceOptions(options);
        setRubMap(plansToPriceMap(data.plans));
        setStarsMap(plansToStarsMap(data.plans));
        setDevices((prev) => (options.includes(prev) ? prev : options[0] ?? 1));
      } catch {
        /* keep fallbacks */
      }
      try {
        const d = await fetchDiscount();
        if (d.active && d.percent > 0) setDiscount(d.percent);
      } catch {
        /* без скидки */
      }
      try {
        const me = await fetchMe();
        if (me && typeof me.partner_balance === "number") setRefBalance(me.partner_balance);
      } catch {
        /* без баланса */
      }
      try {
        const cfg = await fetchConfig();
        if (cfg && cfg.providerMin && typeof cfg.providerMin === "object") {
          setProviderMin(cfg.providerMin as Record<string, number>);
        }
      } catch {
        /* дефолтные минимумы */
      }
    })();
  }, []);

  const isStars = method === "tg_stars";
  const pMin = Number(providerMin[method] ?? (method === "sbp" ? 10 : 50));

  // Актуальная цена с сервера (важно для докупки по остатку дней и сброса трафика,
  // а также чтобы списание с баланса совпадало 1-в-1). Обновляем при изменениях.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const q = await fetchQuote({
        plan_devices: devices,
        months,
        method,
        extra_devices: extraDevices,
        purpose,
        subscription_id: subParam ? Number(subParam) : null,
        use_referral_balance: useRef,
      });
      if (alive) setQuote(q);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, method, extraDevices, useRef, purpose, subParam, months]);

  // Клиентский расчёт (запасной, для мгновенного отклика тарифного экрана).
  const baseRub = rubMap[devices] ?? 99;
  const baseStars = starsMap[devices] ?? baseRub;
  const cRub = applyDiscount(baseRub, discount);
  const cStars = applyDiscount(baseStars, discount);

  // Полная цена (до списания баланса): с сервера, иначе клиентская.
  const fullRub = quote ? Math.round(quote.price) : cRub;
  const stars = quote ? quote.stars : cStars;
  const hasDiscount = discount > 0 && purpose !== "traffic_reset";

  const refApplied = quote && !isStars ? Math.round(quote.referral_applied) : 0;
  const charge = quote && !isStars ? Math.round(quote.charge) : fullRub;
  const canUseRef = !isStars && refBalance > 0 && fullRub > 0;
  // Ниже минимума провайдера — только если что-то платится провайдеру (charge>0).
  const belowMin = !isStars && charge > 0 && charge < pMin;

  const displayBase = isStars ? `${baseStars} ⭐` : `${fullRub} ₽`;
  const displayPrice = isStars
    ? `${stars} ⭐`
    : charge <= 0
      ? "0 ₽"
      : `${charge} ₽`;

  const handlePay = async () => {
    if (paying) return;
    if (belowMin) {
      showError(`Минимальная сумма оплаты этим способом — ${pMin} ₽`);
      return;
    }
    setPaying(true);
    setPayInfo("");
    try {
      const result = await createPayment({
        plan_devices: devices,
        months,
        method,
        extra_devices: extraDevices,
        purpose,
        subscription_id: subParam ? Number(subParam) : null,
        use_referral_balance: canUseRef && useRef,
      });

      const goWaiting = (extra = "") =>
        navigate(
          `/payment/waiting?payment_id=${encodeURIComponent(result.payment_id)}` +
            `&provider=${result.provider}${extra}`,
        );

      // Полностью оплачено реферальным балансом — уже выдано, идём на экран ожидания
      // (он сразу увидит статус paid).
      if (result.provider === "balance" || (result as { paid?: boolean }).paid) {
        setPayInfo("Оплачено с баланса…");
        goWaiting();
      } else if (result.provider === "tg_stars" && result.invoice_link) {
        setPayInfo("Открываем оплату звёздами…");
        void openStarsInvoice(result.invoice_link);
        goWaiting();
      } else if (result.pay_url) {
        setPayInfo("Переход к оплате…");
        openPayUrl(result.pay_url);
        goWaiting(`&pay_url=${encodeURIComponent(result.pay_url)}`);
      } else {
        goWaiting();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Ошибка оплаты";
      setPayInfo("");
      showError(msg);
    } finally {
      setPaying(false);
    }
  };

  const rowStyle = (active: boolean): React.CSSProperties => ({
    position: "relative",
    width: "330px",
    height: "50px",
    background: active ? "rgba(255, 107, 26, 0.7)" : "#352E26",
    borderRadius: "30px",
    border: "none",
    padding: 0,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    paddingLeft: "14px",
    boxSizing: "border-box",
    transition: "background 0.15s ease",
  });

  const pillStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    height: "44px",
    background: active ? "#FF6B1A" : "#352E26",
    borderRadius: "22px",
    border: "none",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "1px",
    transition: "background 0.15s ease",
  });

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "100vh",
        background: "#14110E",
        fontFamily: "'Outfit', system-ui, sans-serif",
      }}
    >
      <div
        style={{
          position: "relative",
          width: "402px",
          height: "803px",
          background: "#14110E",
          overflow: "hidden",
          boxSizing: "border-box",
        }}
      >
        <BackCircleButton onClick={goBack} />

        <div
          style={{
            position: "absolute",
            left: "73px",
            top: "28px",
            fontWeight: 600,
            fontSize: "27px",
            lineHeight: "33px",
            color: "#FFFFFF",
          }}
        >
          Оплата
        </div>

        <div
          style={{
            position: "absolute",
            left: "26px",
            top: "87px",
            width: "350px",
            background: "#2A241E",
            borderRadius: "30px",
            padding: "22px 27px 24px",
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            gap: "20px",
          }}
        >
          <div>
            <div
              style={{
                fontSize: "13px",
                fontWeight: 500,
                color: "#FFFFFF",
                opacity: 0.53,
                marginBottom: "2px",
              }}
            >
              К оплате:
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: "10px",
                transition: "opacity 0.15s ease",
              }}
            >
              <span
                style={{
                  fontSize: "32px",
                  fontWeight: 700,
                  lineHeight: "39px",
                  color: "#FF6B1A",
                }}
              >
                {displayPrice}
              </span>
              {hasDiscount && (
                <span
                  style={{
                    fontSize: "20px",
                    fontWeight: 600,
                    color: "#FFFFFF",
                    opacity: 0.4,
                    textDecoration: "line-through",
                  }}
                >
                  {displayBase}
                </span>
              )}
            </div>
            <div
              style={{
                fontSize: "13px",
                fontWeight: 500,
                color: "#FFFFFF",
                opacity: 0.4,
                marginTop: "2px",
              }}
            >
              {isTrafficReset
                ? "Досрочный сброс трафика"
                : isDevicesFlow
                  ? `Докупка устройств: +${extraDevices}`
                  : `${months} мес · ${devices} ${devices === 1 ? "устройство" : devices < 5 ? "устройства" : "устройств"}`}
            </div>
          </div>

          {purpose === "subscription" && (
          <div>
            <div
              style={{
                fontSize: "13px",
                fontWeight: 500,
                color: "#FFFFFF",
                opacity: 0.53,
                marginBottom: "8px",
              }}
            >
              Количество устройств:
            </div>
            <div style={{ display: "flex", gap: "6px" }}>
              {deviceOptions.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setDevices(n)}
                  style={pillStyle(devices === n)}
                >
                  <span
                    style={{
                      fontSize: "17px",
                      fontWeight: 700,
                      lineHeight: 1,
                      color: "#FFFFFF",
                    }}
                  >
                    {n}
                  </span>
                  <span
                    style={{
                      fontSize: "10px",
                      fontWeight: 500,
                      color: "#FFFFFF",
                      opacity: devices === n ? 0.85 : 0.45,
                      lineHeight: 1,
                    }}
                  >
                    {rubMap[n] ?? "—"} ₽
                  </span>
                </button>
              ))}
            </div>
          </div>
          )}

          <div
            style={{
              height: "1px",
              background: "rgba(255,255,255,0.08)",
              margin: "0 -4px",
            }}
          />

          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div
              style={{
                fontSize: "13px",
                fontWeight: 500,
                color: "#FFFFFF",
                opacity: 0.53,
              }}
            >
              Способ оплаты:
            </div>
            {METHODS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMethod(m.id)}
                style={rowStyle(method === m.id)}
              >
                <span
                  style={{
                    width: 32,
                    height: 32,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {m.icon}
                </span>
                <span
                  style={{
                    fontSize: "17px",
                    fontWeight: 600,
                    color: "#FFFFFF",
                  }}
                >
                  {m.label}
                </span>
                {method === m.id && (
                  <MSIcon
                    name="check_circle"
                    style={{
                      marginLeft: "auto",
                      marginRight: "12px",
                      fontSize: 22,
                      color: "#FFFFFF",
                      opacity: 0.9,
                    }}
                  />
                )}
              </button>
            ))}

            {method !== "tg_stars" && (
              <button
                type="button"
                onClick={() => setSaveCard((v) => !v)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  background: "none",
                  border: "none",
                  padding: "4px 4px 0",
                  cursor: "pointer",
                  boxSizing: "border-box",
                }}
              >
                <span
                  style={{
                    fontSize: "15px",
                    fontWeight: 500,
                    color: "#FFFFFF",
                    opacity: 0.7,
                  }}
                >
                  Сохранить карту
                </span>

                <span
                  style={{
                    position: "relative",
                    display: "inline-block",
                    width: "44px",
                    height: "26px",
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      display: "block",
                      width: "100%",
                      height: "100%",
                      background: saveCard ? "#FF6B1A" : "rgba(255,255,255,0.15)",
                      borderRadius: "13px",
                      transition: "background 0.2s ease",
                    }}
                  />
                  <span
                    style={{
                      position: "absolute",
                      top: "3px",
                      left: saveCard ? "21px" : "3px",
                      width: "20px",
                      height: "20px",
                      background: "#FFFFFF",
                      borderRadius: "50%",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
                      transition: "left 0.2s ease",
                    }}
                  />
                </span>
              </button>
            )}

            {canUseRef && (
              <button
                type="button"
                onClick={() => setUseRef((v) => !v)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  background: "none",
                  border: "none",
                  padding: "2px 4px 0",
                  cursor: "pointer",
                  boxSizing: "border-box",
                }}
              >
                <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                  <span style={{ fontSize: "15px", fontWeight: 500, color: "#FFFFFF", opacity: 0.7 }}>
                    Списать с реф. баланса
                  </span>
                  <span style={{ fontSize: "11px", fontWeight: 500, color: "#FF6B1A", opacity: 0.9 }}>
                    {useRef && refApplied > 0
                      ? `−${refApplied} ₽ · останется ${Math.max(0, Math.floor(refBalance) - refApplied)} ₽`
                      : `доступно ${Math.floor(refBalance)} ₽`}
                  </span>
                </span>
                <span style={{ position: "relative", display: "inline-block", width: "44px", height: "26px", flexShrink: 0 }}>
                  <span
                    style={{
                      display: "block", width: "100%", height: "100%",
                      background: useRef ? "#FF6B1A" : "rgba(255,255,255,0.15)",
                      borderRadius: "13px", transition: "background 0.2s ease",
                    }}
                  />
                  <span
                    style={{
                      position: "absolute", top: "3px", left: useRef ? "21px" : "3px",
                      width: "20px", height: "20px", background: "#FFFFFF", borderRadius: "50%",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.35)", transition: "left 0.2s ease",
                    }}
                  />
                </span>
              </button>
            )}
          </div>
        </div>

        {payInfo && (
          <div
            style={{
              position: "absolute",
              left: "36px",
              top: "680px",
              width: "330px",
              fontSize: 12,
              color: "#AFAFAF",
              textAlign: "center",
            }}
          >
            {payInfo}
          </div>
        )}

        <button
          type="button"
          onClick={() => void handlePay()}
          disabled={paying || belowMin}
          style={{
            position: "absolute",
            width: "330px",
            height: "50px",
            left: "36px",
            top: "717px",
            background: belowMin ? "#555" : "#FF6B1A",
            borderRadius: "30px",
            border: "none",
            padding: 0,
            cursor: paying ? "wait" : belowMin ? "not-allowed" : "pointer",
            opacity: paying ? 0.7 : 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "6px",
          }}
        >
          <span
            style={{
              fontSize: "17px",
              fontWeight: 600,
              color: "#FFFFFF",
            }}
          >
            {paying
              ? "Создаём…"
              : belowMin
                ? `Минимум ${pMin} ₽`
                : charge <= 0 && !isStars
                  ? "Оплатить с баланса"
                  : `Оплатить ${displayPrice}`}
          </span>
          <MSIcon name="chevron_right" style={{ fontSize: 22, color: "#E3E3E3" }} />
        </button>
      </div>
    </div>
  );
}
