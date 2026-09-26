import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Btn, Card, CardLabel, MSIcon, PageHeader, Screen, T, btnReset } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { appFetch, fetchPlans, plansToPriceMap } from "../utils/api";
import { deviceWord, estimateDevicePrice } from "../utils/devices";
import { formatDateRu } from "../utils/date";

const FALLBACK_PRICES: Record<number, number> = { 1: 99, 2: 139, 3: 179, 4: 219, 5: 259 };
const MAX_DEVICES = 20;

type SubKey = { days_left?: number | null; expiry_date?: string | null; devices_limit?: number | null; type?: string | null; no_renew?: boolean | null };
type SubResponse = {
  status?: string;
  key?: SubKey | null;
  expired_key?: SubKey | null;
  delete_at?: string | null;
};

function daysWord(n: number): string {
  const a = n % 100;
  const b = n % 10;
  if (b === 1 && a !== 11) return "день";
  if (b >= 2 && b <= 4 && (a < 12 || a > 14)) return "дня";
  return "дней";
}

export default function ExtendSubscription() {
  const navigate = useNavigate();
  const goBack = useSmartBack("/subscription");
  const [priceMap, setPriceMap] = useState<Record<number, number>>(FALLBACK_PRICES);
  const [extraPrice, setExtraPrice] = useState(40);
  const [devices, setDevices] = useState(1);
  // Меньше, чем уже есть в подписке, выбрать нельзя (уменьшает только админ в панели)
  const [minDevices, setMinDevices] = useState(1);
  const [sub, setSub] = useState<SubResponse | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const data = await fetchPlans();
        if (data.plans.length) setPriceMap(plansToPriceMap(data.plans));
        setExtraPrice(data.extra_device_price || 40);
      } catch {
        /* keep fallbacks */
      }
      try {
        const s = await appFetch<SubResponse>("/subscription");
        setSub(s);
        // По умолчанию продлеваем с тем же числом устройств, что было
        const k = s?.key || s?.expired_key;
        const prev = Number(k?.devices_limit);
        if (Number.isFinite(prev) && prev >= 1) {
          const p = Math.min(MAX_DEVICES, Math.floor(prev));
          setDevices(p);
          // Пробную подписку при покупке можно оформить на любое число устройств
          if (k?.type !== "trial") setMinDevices(p);
        }
      } catch {
        setSub({});
      }
    })();
  }, []);

  const noRenew = !!sub?.key?.no_renew;
  const price = useMemo(() => estimateDevicePrice(devices, priceMap, extraPrice, 1), [devices, priceMap, extraPrice]);
  const expired = sub?.status === "expired";
  const active = sub?.key || null;
  const daysLeft = active?.days_left != null ? Math.max(0, Math.floor(Number(active.days_left))) : null;
  const deleteIn = sub?.delete_at
    ? Math.max(1, Math.ceil((new Date(sub.delete_at).getTime() - Date.now()) / 86_400_000))
    : null;

  const stepBtn: React.CSSProperties = {
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
    flexShrink: 0,
  };

  if (noRenew) {
    return (
      <Screen>
        <PageHeader title="Продлить" onBack={goBack} />
        <Card>
          <CardLabel>Продление</CardLabel>
          <div style={{ fontSize: 22, fontWeight: 700, color: T.text, letterSpacing: "-0.02em", lineHeight: 1.2 }}>
            Недоступно
          </div>
          <div style={{ fontSize: 13, color: T.textMuted, marginTop: 8, lineHeight: 1.45 }}>
            Эту подписку нельзя продлить. Она работает до {sub?.key?.expiry_date ? formatDateRu(sub.key.expiry_date) : "конца срока"}, после чего будет удалена — тогда можно будет оформить новую.
          </div>
        </Card>
        <div style={{ marginTop: "auto", paddingTop: 8 }}>
          <Btn variant="secondary" onClick={() => navigate("/subscription")}>К подписке</Btn>
        </div>
      </Screen>
    );
  }

  return (
    <Screen>
      <PageHeader title="Продлить" onBack={goBack} />

      <Card>
        {expired ? (
          <>
            <CardLabel>Подписка</CardLabel>
            <div style={{ fontSize: 26, fontWeight: 700, color: T.text, letterSpacing: "-0.02em", lineHeight: 1.15 }}>
              Истекла
            </div>
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 6, lineHeight: 1.4 }}>
              {sub?.expired_key?.expiry_date ? `${formatDateRu(sub.expired_key.expiry_date)}` : ""}
              {deleteIn != null ? (
                <span style={{ color: T.danger }}>
                  {sub?.expired_key?.expiry_date ? " · " : ""}удалится через {deleteIn} {daysWord(deleteIn)}
                </span>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <CardLabel>Осталось</CardLabel>
            <div style={{ fontSize: 26, fontWeight: 700, color: T.orange, letterSpacing: "-0.02em", lineHeight: 1.15 }}>
              {sub == null ? "…" : daysLeft == null ? "—" : `${daysLeft} ${daysWord(daysLeft)}`}
            </div>
            {active?.expiry_date ? (
              <div style={{ fontSize: 13, color: T.textMuted, marginTop: 6 }}>до {formatDateRu(active.expiry_date)}</div>
            ) : null}
          </>
        )}
      </Card>

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
          <button type="button" aria-label="Меньше" className="blin-press" disabled={devices <= minDevices} onClick={() => setDevices((v) => Math.max(minDevices, v - 1))} style={{ ...stepBtn, opacity: devices <= minDevices ? 0.35 : 1, cursor: devices <= minDevices ? "default" : "pointer" }}>
            <MSIcon name="remove" style={{ fontSize: 22 }} />
          </button>
          <div style={{ flex: 1, textAlign: "center", fontSize: 16, fontWeight: 600, color: T.text }}>
            {devices} {deviceWord(devices)}
          </div>
          <button type="button" aria-label="Больше" className="blin-press" disabled={devices >= MAX_DEVICES} onClick={() => setDevices((v) => Math.min(MAX_DEVICES, v + 1))} style={{ ...stepBtn, opacity: devices >= MAX_DEVICES ? 0.35 : 1, cursor: devices >= MAX_DEVICES ? "default" : "pointer" }}>
            <MSIcon name="add" style={{ fontSize: 22 }} />
          </button>
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
          <div style={{ fontSize: 14, color: T.textMuted }}>1 месяц</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: T.orange }}>{price} ₽</div>
        </div>
      </Card>

      <div style={{ marginTop: "auto", paddingTop: 8 }}>
        <Btn onClick={() => navigate(`/payment?devices=${devices}&purpose=extend`)}>
          Продлить за {price} ₽
        </Btn>
      </div>
    </Screen>
  );
}
