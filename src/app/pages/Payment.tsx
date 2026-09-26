import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Btn, Card, CardLabel, MSIcon, PageHeader, Screen, T, btnReset } from "../components/ui";
import { useAppError } from "../components/ErrorModal";
import PaymentSheet, { type PendingPayment } from "../components/PaymentSheet";
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
const MAX_DEVICES = 20;

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
  const [searchParams] = useSearchParams();

  const returnTo = searchParams.get("return") || "";
  // Если количество устройств уже выбрали на предыдущем экране — второй раз не спрашиваем.
  const devicesPreselected = searchParams.has("devices");
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
  const [discount, setDiscount] = useState(0);
  const [refBalance, setRefBalance] = useState(0);
  const [providerMin, setProviderMin] = useState<Record<string, number>>({
    card: 50,
    sberpay: 50,
    sbp: 10,
  });
  const [useRefBal, setUseRefBal] = useState(false);
  const [quote, setQuote] = useState<PaymentQuote | null>(null);
  const [quoteReady, setQuoteReady] = useState(false);
  const [pending, setPending] = useState<PendingPayment | null>(null);

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
        /* keep */
      }
      try {
        const d = await fetchDiscount();
        if (d.active && d.percent > 0) setDiscount(d.percent);
      } catch {
        /* */
      }
      try {
        const me = await fetchMe();
        if (me && typeof me.partner_balance === "number") setRefBalance(me.partner_balance);
      } catch {
        /* */
      }
      try {
        const cfg = await fetchConfig();
        if (cfg?.providerMin && typeof cfg.providerMin === "object") {
          setProviderMin(cfg.providerMin as Record<string, number>);
        }
      } catch {
        /* */
      }
    })();
  }, []);

  const isStars = method === "tg_stars";
  const pMin = Number(providerMin[method] ?? (method === "sbp" ? 10 : 50));

  useEffect(() => {
    let alive = true;
    setQuoteReady(false);
    void (async () => {
      const q = await fetchQuote({
        plan_devices: planDevices,
        months,
        method,
        extra_devices: extraDevices,
        purpose,
        subscription_id: subParam ? Number(subParam) : null,
        use_referral_balance: useRefBal,
      });
      if (!alive) return;
      setQuote(q);
      setQuoteReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [planDevices, method, extraDevices, useRefBal, purpose, subParam, months]);

  const clientRub = estimateDevicePrice(devices, rubMap, extraPrice, months);
  const baseStars = starsMap[planDevices] ?? clientRub;
  const cRub = applyDiscount(clientRub, discount);
  const cStars = applyDiscount(baseStars, discount);

  const fullRub = quote ? Math.round(quote.price) : cRub;
  const stars = quote ? quote.stars : cStars;
  const hasDiscount = discount > 0 && purpose !== "traffic_reset" && quoteReady && !!quote;
  const refApplied = quote && !isStars ? Math.round(quote.referral_applied) : 0;
  const charge = quote && !isStars ? Math.round(quote.charge) : fullRub;
  const canUseRef = quoteReady && !isStars && refBalance > 0 && fullRub > 0;
  const belowMin = quoteReady && !isStars && charge > 0 && charge < pMin;
  const paidFromBalance = quoteReady && !isStars && charge <= 0 && fullRub > 0;

  const displayPrice = !quoteReady
    ? "…"
    : isStars
      ? `${stars} ⭐`
      : paidFromBalance
        ? "0 ₽"
        : `${charge} ₽`;
  const strikePrice = hasDiscount ? `${cRub > fullRub ? cRub : Math.round(fullRub / Math.max(0.01, 1 - discount / 100))} ₽` : null;

  const payLabel = !quoteReady
    ? "Считаем…"
    : paying
      ? "Создаём…"
      : belowMin
        ? `Минимум ${pMin} ₽`
        : paidFromBalance
          ? "Оплатить с баланса"
          : `Оплатить ${displayPrice}`;

  const handlePay = async () => {
    if (paying || !quoteReady) return;
    if (belowMin) {
      showError(`Минимальная сумма оплаты этим способом — ${pMin} ₽`);
      return;
    }
    setPaying(true);
    try {
      const result = await createPayment({
        plan_devices: planDevices,
        months,
        method,
        extra_devices: extraDevices,
        purpose,
        subscription_id: subParam ? Number(subParam) : null,
        use_referral_balance: canUseRef && useRefBal,
        return_to: returnTo || "/subscription",
      });

      // Вместо отдельной страницы — нижнее окно ожидания поверх оплаты
      const goWaiting = (extra: Partial<PendingPayment> = {}) =>
        setPending({
          paymentId: String(result.payment_id),
          provider: String(result.provider || ""),
          invoiceLink: result.invoice_link || undefined,
          purpose,
          ...extra,
        });

      if (result.provider === "balance" || (result as { paid?: boolean }).paid) {
        goWaiting();
      } else if (result.provider === "tg_stars" && result.invoice_link) {
        void openStarsInvoice(result.invoice_link);
        goWaiting();
      } else if (result.pay_url) {
        openPayUrl(result.pay_url);
        goWaiting({ payUrl: result.pay_url });
      } else {
        goWaiting();
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : "Ошибка оплаты");
      } finally {
      setPaying(false);
    }
  };

  const stepBtn: React.CSSProperties = {
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
    flexShrink: 0,
  };

  return (
    <Screen>
      <PageHeader title="Оплата" onBack={goBack} />

      <Card>
        <CardLabel>К оплате</CardLabel>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 30, fontWeight: 700, color: T.orange, letterSpacing: "-0.02em", lineHeight: 1.15 }}>
            {displayPrice}
          </span>
          {hasDiscount && strikePrice ? (
            <span style={{ fontSize: 15, fontWeight: 600, color: T.textDim, textDecoration: "line-through" }}>
              {strikePrice}
            </span>
          ) : null}
        </div>
        <div style={{ fontSize: 13, color: T.textMuted, marginTop: 6, lineHeight: 1.4 }}>
          {isTrafficReset
            ? "Досрочный сброс трафика"
            : isDevicesFlow
              ? `Докупка устройств: +${extraDevices}`
              : `${months} мес · ${devices} ${deviceWord(devices)}`}
        </div>
      </Card>

      {purpose === "subscription" && !devicesPreselected ? (
        <Card>
          <CardLabel>Количество устройств</CardLabel>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              background: T.surfaceRaised,
              borderRadius: T.radius.md,
              padding: 6,
            }}
          >
            <button
              type="button"
              aria-label="Меньше"
              className="blin-press"
              onClick={() => setDevices((v) => Math.max(1, v - 1))}
              style={stepBtn}
            >
              <MSIcon name="remove" style={{ color: T.text, fontSize: 22 }} />
            </button>
            <div style={{ flex: 1, textAlign: "center", minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: T.text }}>
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
              style={stepBtn}
            >
              <MSIcon name="add" style={{ color: T.text, fontSize: 22 }} />
            </button>
          </div>
        </Card>
      ) : null}

      <Card>
        <CardLabel>Способ оплаты</CardLabel>
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
                  minHeight: 52,
                  padding: "0 14px",
                  borderRadius: T.radius.md,
                  background: active ? T.orangeSoft : T.surfaceRaised,
                  border: `1px solid ${active ? T.orange : "transparent"}`,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  boxSizing: "border-box",
                }}
              >
                <span style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {m.icon}
                </span>
                <span style={{ flex: 1, textAlign: "left", fontSize: 15, fontWeight: 600, color: T.text }}>
                  {m.label}
                </span>
                <MSIcon
                  name={active ? "radio_button_checked" : "radio_button_unchecked"}
                  style={{ fontSize: 22, color: active ? T.orange : T.textDim, flexShrink: 0 }}
                />
              </button>
            );
          })}
        </div>

        {canUseRef ? (
          <button
            type="button"
            onClick={() => setUseRefBal((v) => !v)}
            style={{
              ...btnReset,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
              marginTop: 14,
              paddingTop: 14,
              background: "transparent",
              border: "none",
              borderTop: `1px solid ${T.border}`,
              gap: 12,
              cursor: "pointer",
            }}
          >
            <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: 0 }}>
              <span style={{ fontSize: 15, fontWeight: 500, color: T.text }}>Списать с баланса</span>
              <span style={{ fontSize: 12, fontWeight: 500, color: T.orange, marginTop: 2 }}>
                {useRefBal && refApplied > 0
                  ? `−${refApplied} ₽ · останется ${Math.max(0, Math.floor(refBalance) - refApplied)} ₽`
                  : `доступно ${Math.floor(refBalance)} ₽`}
              </span>
            </span>
            <span style={{ position: "relative", width: 44, height: 26, flexShrink: 0 }}>
              <span
                style={{
                  display: "block",
                  width: "100%",
                  height: "100%",
                  background: useRefBal ? T.orange : "rgba(255,255,255,0.15)",
                  borderRadius: 13,
                  transition: "background 0.18s ease",
                }}
              />
              <span
                style={{
                  position: "absolute",
                  top: 3,
                  left: useRefBal ? 21 : 3,
                  width: 20,
                  height: 20,
                  background: "#fff",
                  borderRadius: "50%",
                  transition: "left 0.18s var(--ease-out)",
                }}
              />
            </span>
          </button>
        ) : null}
      </Card>

      <div style={{ marginTop: "auto", paddingTop: 8 }}>
        <Btn disabled={paying || !quoteReady || belowMin} onClick={() => void handlePay()}>
          {payLabel}
        </Btn>
      </div>

      {pending ? (
        <PaymentSheet payment={pending} returnTo={returnTo} onClose={() => setPending(null)} />
      ) : null}
    </Screen>
  );
}
