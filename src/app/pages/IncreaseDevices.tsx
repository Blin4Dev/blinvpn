import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Btn, MSIcon, PageHeader, Screen, Surface, T, btnReset } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { fetchPlans, fetchQuote, fetchSubscription } from "../utils/api";
import { deviceWord } from "../utils/devices";

const MAX_DEVICES = 15;

export default function IncreaseDevices() {
  const navigate = useNavigate();
  const goBack = useSmartBack("/subscription");

  const [baseIncluded, setBaseIncluded] = useState(1);
  const [pricePerDeviceRub, setPricePerDeviceRub] = useState(40);
  const [targetMax, setTargetMax] = useState(2);
  const [subId, setSubId] = useState<number | null>(null);
  const [daysLeft, setDaysLeft] = useState(0);
  const [totalRub, setTotalRub] = useState(0);
  const [quoteBusy, setQuoteBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const data = await fetchPlans();
        setPricePerDeviceRub(data.extra_device_price || 40);
      } catch {
        /* keep defaults */
      }
      try {
        const sub = await fetchSubscription();
        const k = sub?.key;
        const limit = Math.max(1, Number(k?.devices_limit ?? 1));
        setBaseIncluded(limit);
        setTargetMax(Math.min(MAX_DEVICES, limit + 1));
        if (k?.id) setSubId(Number(k.id));
        let dl = Number(k?.days_left ?? NaN);
        if (!Number.isFinite(dl) && k?.expiry_date) {
          dl = Math.max(0, Math.ceil((new Date(k.expiry_date).getTime() - Date.now()) / 86400000));
        }
        if (Number.isFinite(dl)) setDaysLeft(Math.max(0, Math.floor(dl)));
      } catch {
        /* keep defaults */
      }
    })();
  }, []);

  const extra = Math.max(0, targetMax - baseIncluded);

  useEffect(() => {
    if (extra <= 0) {
      setTotalRub(0);
      return;
    }
    let alive = true;
    setQuoteBusy(true);
    void (async () => {
      const q = await fetchQuote({
        plan_devices: 1,
        months: 1,
        method: "sbp",
        extra_devices: extra,
        purpose: "devices",
        subscription_id: subId,
        use_referral_balance: false,
      });
      if (!alive) return;
      if (q) setTotalRub(Math.round(q.price));
      else {
        // запасной клиентский расчёт как на сервере
        setTotalRub(Math.round(extra * pricePerDeviceRub * (Math.min(daysLeft, 3650) / 30)));
      }
      setQuoteBusy(false);
    })();
    return () => {
      alive = false;
    };
  }, [extra, subId, pricePerDeviceRub, daysLeft]);

  const title = useMemo(() => {
    if (extra === 0) return "Докупка устройств";
    return `+${extra} ${deviceWord(extra)}`;
  }, [extra]);

  return (
    <Screen>
      <PageHeader title="Устройства" onBack={goBack} />

      <Surface padded style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 600, color: T.text, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.45 }}>
          Сейчас в подписке {baseIncluded} {deviceWord(baseIncluded)}. Доп. слот — {pricePerDeviceRub} ₽/мес,
          оплата только за остаток срока (~{daysLeft} дн.). Срок подписки не меняется.
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginTop: 18,
            background: T.surfaceRaised,
            borderRadius: T.radius.lg,
            padding: "10px 12px",
          }}
        >
          <button
            type="button"
            aria-label="Меньше"
            className="blin-press"
            onClick={() => setTargetMax((v) => Math.max(baseIncluded, v - 1))}
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
              {targetMax} {deviceWord(targetMax)}
            </div>
            <div style={{ fontSize: 12, color: T.textDim, marginTop: 2 }}>
              +{extra} / {Math.max(0, MAX_DEVICES - baseIncluded)} доп.
            </div>
          </div>
          <button
            type="button"
            aria-label="Больше"
            className="blin-press"
            onClick={() => setTargetMax((v) => Math.min(MAX_DEVICES, v + 1))}
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

        <div
          style={{
            marginTop: 16,
            paddingTop: 14,
            borderTop: `1px solid ${T.border}`,
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 13, color: T.textMuted }}>Итого</span>
          <span style={{ fontSize: 28, fontWeight: 700, color: T.orange }}>
            {quoteBusy && extra > 0 ? "…" : `${totalRub} ₽`}
          </span>
        </div>
      </Surface>

      <Btn
        disabled={extra === 0 || totalRub <= 0}
        onClick={() =>
          navigate(
            `/payment?type=devices&count=${extra}&amount=${totalRub}${subId ? `&sub=${subId}` : ""}`,
          )
        }
      >
        Перейти к оплате
      </Btn>
    </Screen>
  );
}
