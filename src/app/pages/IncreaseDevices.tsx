import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Btn, Card, CardLabel, MSIcon, PageHeader, Screen, T, btnReset } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { fetchPlans, fetchQuote, fetchSubscription } from "../utils/api";
import { deviceWord } from "../utils/devices";
import { formatDateRu } from "../utils/date";

const MAX_DEVICES = 20;

function daysWord(n: number): string {
  const a = n % 100;
  const b = n % 10;
  if (b === 1 && a !== 11) return "день";
  if (b >= 2 && b <= 4 && (a < 12 || a > 14)) return "дня";
  return "дней";
}

export default function IncreaseDevices() {
  const navigate = useNavigate();
  const goBack = useSmartBack("/subscription");

  const [loaded, setLoaded] = useState(false);
  const [current, setCurrent] = useState(1);
  // Сколько устройств БУДЕТ в подписке. Меньше текущего выбрать нельзя
  // (уменьшить лимит может только администратор в панели).
  const [target, setTarget] = useState(2);
  const [pricePerDevice, setPricePerDevice] = useState(40);
  const [subId, setSubId] = useState<number | null>(null);
  const [daysLeft, setDaysLeft] = useState(0);
  const [expiry, setExpiry] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [quoteBusy, setQuoteBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const data = await fetchPlans();
        setPricePerDevice(data.extra_device_price || 40);
      } catch {
        /* keep defaults */
      }
      try {
        const sub = await fetchSubscription();
        const k = sub?.key;
        const cur = Math.max(1, Number(k?.devices_limit ?? 1));
        setCurrent(cur);
        setTarget(Math.min(MAX_DEVICES, cur + 1));
        if (k?.id) setSubId(Number(k.id));
        if (k?.expiry_date) setExpiry(String(k.expiry_date));
        let dl = Number(k?.days_left ?? NaN);
        if (!Number.isFinite(dl) && k?.expiry_date) {
          dl = Math.ceil((new Date(k.expiry_date).getTime() - Date.now()) / 86400000);
        }
        if (Number.isFinite(dl)) setDaysLeft(Math.max(0, Math.floor(dl)));
      } catch {
        /* keep defaults */
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const maxAdd = Math.max(0, MAX_DEVICES - current);
  const minTarget = Math.min(MAX_DEVICES, current + 1);
  const total_ = Math.min(MAX_DEVICES, Math.max(minTarget, target));
  const extra = Math.max(0, total_ - current);

  useEffect(() => {
    if (extra <= 0) {
      setTotal(0);
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
      if (q) setTotal(Math.round(q.price));
      else setTotal(Math.round(extra * pricePerDevice * (Math.min(daysLeft, 3650) / 30)));
      setQuoteBusy(false);
    })();
    return () => {
      alive = false;
    };
  }, [extra, subId, pricePerDevice, daysLeft]);

  const stepBtn = (disabled: boolean): React.CSSProperties => ({
    ...btnReset,
    width: 44,
    height: 44,
    borderRadius: 12,
    background: T.surface,
    border: `1px solid ${T.border}`,
    color: T.text,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.35 : 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  });

  const priceText = quoteBusy ? "…" : `${total} ₽`;

  return (
    <Screen>
      <PageHeader title="Докупить устройства" onBack={goBack} />

      <Card>
        <CardLabel>Сейчас в подписке</CardLabel>
        <div style={{ fontSize: 26, fontWeight: 700, color: T.text, letterSpacing: "-0.02em", lineHeight: 1.15 }}>
          {loaded ? `${current} ${deviceWord(current)}` : "…"}
        </div>
        {expiry ? (
          <div style={{ fontSize: 13, color: T.textMuted, marginTop: 6 }}>
            до {formatDateRu(expiry)} · осталось {daysLeft} {daysWord(daysLeft)}
          </div>
        ) : null}
      </Card>

      {maxAdd === 0 && loaded ? (
        <Card>
          <div style={{ fontSize: 14, color: T.textMuted, lineHeight: 1.45 }}>
            В подписке уже максимум — {MAX_DEVICES} устройств.
          </div>
        </Card>
      ) : (
        <Card>
          <CardLabel>Будет устройств</CardLabel>
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
              disabled={total_ <= minTarget}
              onClick={() => setTarget((v) => Math.max(minTarget, v - 1))}
              style={stepBtn(total_ <= minTarget)}
            >
              <MSIcon name="remove" style={{ fontSize: 22 }} />
            </button>
            <div style={{ flex: 1, textAlign: "center", fontSize: 16, fontWeight: 600, color: T.text }}>
              {total_} {deviceWord(total_)}
            </div>
            <button
              type="button"
              aria-label="Больше"
              className="blin-press"
              disabled={total_ >= MAX_DEVICES}
              onClick={() => setTarget((v) => Math.min(MAX_DEVICES, v + 1))}
              style={stepBtn(total_ >= MAX_DEVICES)}
            >
              <MSIcon name="add" style={{ fontSize: 22 }} />
            </button>
          </div>

          <div style={{ fontSize: 13, color: T.textMuted, marginTop: 10, textAlign: "center" }}>
            +{extra} к текущим {current}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              marginTop: 14,
              paddingTop: 12,
              borderTop: `1px solid ${T.border}`,
            }}
          >
            <div style={{ fontSize: 14, color: T.textMuted }}>За остаток срока</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: T.orange }}>{priceText}</div>
          </div>
        </Card>
      )}

      <div style={{ fontSize: 13, color: T.textDim, lineHeight: 1.45, padding: "0 4px" }}>
        {pricePerDevice} ₽ в месяц за устройство — платите только за оставшиеся дни. Дата окончания подписки не меняется.
      </div>

      <div style={{ marginTop: "auto", paddingTop: 16 }}>
        <Btn
          disabled={extra === 0 || total <= 0 || quoteBusy}
          onClick={() =>
            navigate(`/payment?type=devices&count=${extra}&amount=${total}${subId ? `&sub=${subId}` : ""}`)
          }
        >
          {extra > 0 && total > 0 && !quoteBusy ? `Оплатить ${total} ₽` : "Оплатить"}
        </Btn>
      </div>
    </Screen>
  );
}
