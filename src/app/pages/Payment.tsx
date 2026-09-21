import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Btn, MSIcon, PageHeader, Screen, Surface, T, btnReset } from "../components/ui";
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
import { deviceWord, estimateDevicePrice, splitDevices } from "../utils/devices";

const FALLBACK_OPTIONS = [1, 2, 3, 5];
const MAX_DEVICES = 15;

type PaymentMethod = "sbp" | "card" | "tg_stars";

const METHODS: { id: PaymentMethod; label: string; icon: React.ReactNode }[] = [
  {
    id: "sbp",
    label: "СБП",
    icon: (
      <img
        src="https://i.imgur.com/pu9w7tE.png"
        alt=""
        style={{ width: 28, height: 28, objectFit: "contain" }}
      />
    ),
  },
  {
    id: "card",
    label: "Банковская карта",
    icon: <MSIcon name="credit_card" style={{ fontSize: 26, color: T.text }} />,
  },
  {
    id: "tg_stars",
    label: "Звёзды Telegram",
    icon: (
      <img
        src="https://i.imgur.com/Yu8PZ7N.png"
        alt=""
        style={{ width: 28, height: 28, objectFit: "contain" }}
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
    MAX_DEVICES,
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
  const extraDevicesParam = isDevicesFlow
    ? Math.max(0, parseInt(searchParams.get("count") || "0", 10))
    : 0;

  const [devices, setDevices] = useState(initialDevices);
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
  const [extraPrice, setExtraPrice] = useState(40);
  const [method, setMethod] = useState<PaymentMethod>("sbp");
  const [paying, setPaying] = useState(false);
  const [payInfo, setPayInfo] = useState("");
  const [discount, setDiscount] = useState(0);
  const [refBalance, setRefBalance] = useState(0);
  const [providerMin, setProviderMin] = useState<Record<string, number>>({
    card: 50,
    sberpay: 50,
    sbp: 10,
  });
  const [useRef, setUseRef] = useState(false);
  const [quote, setQuote] = useState<PaymentQuote | null>(null);

  const planSizes = useMemo(
    () => Object.keys(rubMap).map(Number).sort((a, b) => a - b),
    [rubMap],
  );
  const split = splitDevices(devices, planSizes.length ? planSizes : FALLBACK_OPTIONS);
  const extraDevices = isDevicesFlow ? extraDevicesParam : split.extra;
  const planDevices = isDevicesFlow ? 1 : split.plan;

  useEffect(() => {
    void (async () => {
      try {
        const data = await fetchPlans();
        setRubMap(plansToPriceMap(data.plans));
        setStarsMap(plansToStarsMap(data.plans));
        setExtraPrice(data.extra_device_price || 40);
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

  useEffect(() => {
    let alive = true;
    void (async () => {
      const q = await fetchQuote({
        plan_devices: planDevices,
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
  }, [planDevices, method, extraDevices, useRef, purpose, subParam, months]);

  const clientRub = estimateDevicePrice(devices, rubMap, extraPrice, months);
  const baseRub = isDevicesFlow ? clientRub : clientRub;
  const baseStars = starsMap[planDevices] ?? baseRub;
  const cRub = applyDiscount(baseRub, discount);
  const cStars = applyDiscount(baseStars, discount);

  const fullRub = quote ? Math.round(quote.price) : cRub;
  const stars = quote ? quote.stars : cStars;
  const hasDiscount = discount > 0 && purpose !== "traffic_reset";

  const refApplied = quote && !isStars ? Math.round(quote.referral_applied) : 0;
  const charge = quote && !isStars ? Math.round(quote.charge) : fullRub;
  const canUseRef = !isStars && refBalance > 0 && fullRub > 0;
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
        plan_devices: planDevices,
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

  return (
    <Screen>
      <PageHeader title="Оплата" onBack={goBack} />

      <Surface padded style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 4 }}>К оплате</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 32, fontWeight: 700, color: T.orange, letterSpacing: "-0.02em" }}>
            {displayPrice}
          </span>
          {hasDiscount ? (
            <span style={{ fontSize: 18, fontWeight: 600, color: T.textDim, textDecoration: "line-through" }}>
              {displayBase}
            </span>
          ) : null}
        </div>
        <div style={{ fontSize: 13, color: T.textDim, marginTop: 4 }}>
          {isTrafficReset
            ? "Досрочный сброс трафика"
            : isDevicesFlow
              ? `Докупка устройств: +${extraDevices}`
              : `${months} мес · ${devices} ${deviceWord(devices)}`}
        </div>
      </Surface>

      {purpose === "subscription" && (
        <Surface padded style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 12 }}>Количество устройств</div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              background: T.surfaceRaised,
              borderRadius: T.radius.lg,
              padding: "10px 12px",
            }}
          >
            <button
              type="button"
              aria-label="Меньше"
              className="blin-press"
              onClick={() => setDevices((v) => Math.max(1, v - 1))}
              style={{
                ...btnReset,
                width: 44,
                height: 44,
                borderRadius: 12,
                background: T.surface,
                border: `1px solid ${T.border}`,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <MSIcon name="remove" style={{ color: T.text }} />
            </button>
            <div style={{ flex: 1, textAlign: "center" }}>
              <div style={{ fontSize: 18, fontWeight: 600, color: T.text }}>
                {devices} {deviceWord(devices)}
              </div>
              {split.extra > 0 ? (
                <div style={{ fontSize: 12, color: T.textDim, marginTop: 2 }}>
                  тариф {split.plan} + {split.extra} доп.
                </div>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Больше"
              className="blin-press"
              onClick={() => setDevices((v) => Math.min(MAX_DEVICES, v + 1))}
              style={{
                ...btnReset,
                width: 44,
                height: 44,
                borderRadius: 12,
                background: T.surface,
                border: `1px solid ${T.border}`,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <MSIcon name="add" style={{ color: T.text }} />
            </button>
          </div>
        </Surface>
      )}

      <Surface padded style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 10 }}>Способ оплаты</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {METHODS.map((m) => {
            const active = method === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setMethod(m.id)}
                className="blin-press"
                style={{
                  ...btnReset,
                  width: "100%",
                  minHeight: 50,
                  padding: "0 14px",
                  borderRadius: T.radius.lg,
                  background: active ? "rgba(255, 107, 26, 0.7)" : T.surfaceRaised,
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  boxSizing: "border-box",
                }}
              >
                <span
                  style={{
                    width: 28,
                    height: 28,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {m.icon}
                </span>
                <span style={{ flex: 1, textAlign: "left", fontSize: 16, fontWeight: 600, color: T.text }}>
                  {m.label}
                </span>
                {active ? (
                  <MSIcon name="check_circle" style={{ fontSize: 22, color: "#fff", opacity: 0.9 }} />
                ) : null}
              </button>
            );
          })}
        </div>

        {canUseRef ? (
          <button
            type="button"
            onClick={() => setUseRef((v) => !v)}
            style={{
              ...btnReset,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
              marginTop: 14,
              cursor: "pointer",
            }}
          >
            <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
              <span style={{ fontSize: 15, fontWeight: 500, color: T.text, opacity: 0.85 }}>
                Списать с баланса
              </span>
              <span style={{ fontSize: 11, fontWeight: 500, color: T.orange }}>
                {useRef && refApplied > 0
                  ? `−${refApplied} ₽ · останется ${Math.max(0, Math.floor(refBalance) - refApplied)} ₽`
                  : `доступно ${Math.floor(refBalance)} ₽`}
              </span>
            </span>
            <span style={{ position: "relative", display: "inline-block", width: 44, height: 26, flexShrink: 0 }}>
              <span
                style={{
                  display: "block",
                  width: "100%",
                  height: "100%",
                  background: useRef ? T.orange : "rgba(255,255,255,0.15)",
                  borderRadius: 13,
                }}
              />
              <span
                style={{
                  position: "absolute",
                  top: 3,
                  left: useRef ? 21 : 3,
                  width: 20,
                  height: 20,
                  background: "#fff",
                  borderRadius: "50%",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
                }}
              />
            </span>
          </button>
        ) : null}
      </Surface>

      {payInfo ? (
        <div style={{ fontSize: 12, color: T.textMuted, textAlign: "center", marginBottom: 10 }}>
          {payInfo}
        </div>
      ) : null}

      <Btn disabled={paying || belowMin} onClick={() => void handlePay()}>
        {paying
          ? "Создаём…"
          : belowMin
            ? `Минимум ${pMin} ₽`
            : charge <= 0 && !isStars
              ? "Оплатить с баланса"
              : `Оплатить ${displayPrice}`}
      </Btn>
    </Screen>
  );
}
