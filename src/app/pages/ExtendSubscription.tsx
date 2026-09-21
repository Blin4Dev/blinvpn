import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Btn, MSIcon, PageHeader, Screen, Surface, T, btnReset } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { appFetch, fetchPlans, plansToPriceMap } from "../utils/api";
import { deviceWord, estimateDevicePrice, splitDevices } from "../utils/devices";

const FALLBACK_OPTIONS = [1, 2, 3, 5];
const FALLBACK_PRICES: Record<number, number> = { 1: 99, 2: 169, 3: 229, 5: 349 };
const MAX_DEVICES = 15;

export default function ExtendSubscription() {
  const navigate = useNavigate();
  const goBack = useSmartBack("/subscription");
  const [priceMap, setPriceMap] = useState<Record<number, number>>(FALLBACK_PRICES);
  const [extraPrice, setExtraPrice] = useState(40);
  const [devices, setDevices] = useState(1);
  const [daysLeft, setDaysLeft] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const data = await fetchPlans();
        const opts =
          data.plans.length > 0
            ? data.plans.map((p) => p.devices).sort((a, b) => a - b)
            : FALLBACK_OPTIONS;
        setPriceMap(plansToPriceMap(data.plans));
        setExtraPrice(data.extra_device_price || 40);
        setDevices((prev) => (opts.includes(prev) ? prev : opts[0] ?? 1));
      } catch {
        /* keep fallbacks */
      }
      try {
        const sub = await appFetch<{ key?: { days_left?: number | null } | null }>("/subscription");
        const dl = Number(sub?.key?.days_left);
        if (Number.isFinite(dl)) setDaysLeft(Math.max(0, Math.floor(dl)));
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const planSizes = useMemo(() => Object.keys(priceMap).map(Number).sort((a, b) => a - b), [priceMap]);
  const { plan, extra } = splitDevices(devices, planSizes);
  const price = estimateDevicePrice(devices, priceMap, extraPrice, 1);

  return (
    <Screen>
      <PageHeader title="Продлить" onBack={goBack} />

      <Surface padded style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 500, letterSpacing: "0.04em", textTransform: "uppercase", color: T.textDim }}>
          Осталось
        </div>
        <div style={{ fontSize: 32, fontWeight: 700, color: T.orange, marginTop: 4, letterSpacing: "-0.02em" }}>
          {daysLeft == null ? "—" : `${daysLeft} дн`}
        </div>
        <div style={{ fontSize: 13, color: T.textMuted, marginTop: 6 }}>
          Выберите число устройств для продления на 1 месяц
        </div>
      </Surface>

      <Surface padded style={{ marginBottom: 16 }}>
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
              color: T.text,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <MSIcon name="remove" />
          </button>
          <div style={{ flex: 1, textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: T.text }}>
              {devices} {deviceWord(devices)}
            </div>
            {extra > 0 ? (
              <div style={{ fontSize: 12, color: T.textDim, marginTop: 2 }}>
                тариф {plan} + {extra} доп.
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
              color: T.text,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <MSIcon name="add" />
          </button>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 16,
            paddingTop: 14,
            borderTop: `1px solid ${T.border}`,
          }}
        >
          <div style={{ fontSize: 14, color: T.textMuted }}>1 месяц</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: T.orange }}>{price} ₽</div>
        </div>
      </Surface>

      <Btn onClick={() => navigate(`/payment?devices=${devices}&purpose=extend`)}>
        Продлить за {price} ₽
      </Btn>
    </Screen>
  );
}
