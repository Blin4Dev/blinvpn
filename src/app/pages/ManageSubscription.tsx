import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ActionButton, Btn, PageHeader, Screen, SectionLabel, T, btnReset } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import {
  appFetch,
  fetchAppLink,
  fetchConfig,
  fetchPlans,
  minPlanPrice,
  openDeepLink,
} from "../utils/api";

function pad2(n: number) {
  return n.toString().padStart(2, "0");
}

function useCountdown(target: Date) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  return useMemo(() => {
    const now = Date.now();
    const ms = Math.max(0, target.getTime() - now);
    const days = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return { days, h, m, s, ms };
  }, [target, tick]);
}

export default function ManageSubscription() {
  const navigate = useNavigate();
  const location = useLocation();
  const goBack = useSmartBack("/");

  const [untilIso, setUntilIso] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [minPrice, setMinPrice] = useState(99);
  const [devicesSummary, setDevicesSummary] = useState("—");
  const [trafficResetPrice, setTrafficResetPrice] = useState(0);
  const [appSheet, setAppSheet] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [linkErr, setLinkErr] = useState("");

  useEffect(() => {
    if (new URLSearchParams(location.search).get("setup") === "1") {
      setAppSheet(true);
    }
  }, [location.search]);

  const pickApp = async (which: "incy" | "happ" | "other") => {
    if (linking) return;
    setLinking(which);
    setLinkErr("");
    try {
      const res = await fetchAppLink(which);
      openDeepLink(res);
      setAppSheet(false);
    } catch (e) {
      setLinkErr(e instanceof Error ? e.message : "Не удалось получить ссылку");
    } finally {
      setLinking(null);
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const plans = await fetchPlans();
        setMinPrice(minPlanPrice(plans.plans));
      } catch { /* keep 99 */ }
      try {
        const cfg = await fetchConfig();
        const p = Number((cfg as { trafficResetPrice?: number }).trafficResetPrice ?? 0);
        if (Number.isFinite(p)) setTrafficResetPrice(p);
      } catch { /* без сброса */ }
      try {
        const data = await appFetch<{
          until?: string | null;
          key?: { devices_limit?: number; days_left?: number | null } | null;
        }>("/subscription");
        if (!data.until) {
          setLoaded(true);
          navigate("/subscription/start", { replace: true });
          return;
        }
        setUntilIso(data.until);
        const limit = data.key?.devices_limit;
        if (limit != null) setDevicesSummary(`лимит ${limit}`);
      } catch { /* placeholder */ } finally {
        setLoaded(true);
      }
    })();
  }, [navigate]);

  const validUntil = useMemo(
    () => (untilIso ? new Date(untilIso) : new Date(Date.now() + 86400000)),
    [untilIso],
  );
  const { days, h, m, s } = useCountdown(validUntil);

  const untilLabel = untilIso
    ? new Date(untilIso).toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : loaded
      ? "нет активной подписки"
      : "загрузка…";

  return (
    <Screen>
      <PageHeader title="Подписка" onBack={goBack} />

      <div style={{ marginBottom: 22 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 500,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: T.textDim,
            marginBottom: 8,
          }}
        >
          Осталось
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 4,
            fontWeight: 700,
            fontSize: 36,
            letterSpacing: "-0.03em",
            color: T.text,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1,
          }}
        >
          <span style={{ color: T.orange }}>{days}</span>
          <span style={{ fontSize: 18, fontWeight: 600, color: T.textMuted, marginRight: 8 }}>дн</span>
          <span style={{ fontSize: 22, fontWeight: 600, color: T.textMuted }}>
            {pad2(h)}:{pad2(m)}:{pad2(s)}
          </span>
        </div>
        <div style={{ marginTop: 10, fontSize: 14, color: T.textMuted }}>
          Действует до {untilLabel}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <ActionButton
          primary
          icon="download"
          title="Добавить подписку"
          meta="в приложение"
          onClick={() => setAppSheet(true)}
        />
        <ActionButton
          icon="shopping_bag"
          title="Продлить подписку"
          meta={`от ${minPrice} ₽`}
          onClick={() => navigate("/subscription/extend")}
        />
        <ActionButton
          icon="devices"
          title="Мои устройства"
          meta={devicesSummary}
          onClick={() => navigate("/subscription/devices")}
        />
      </div>

      <SectionLabel>Дополнительно</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <ActionButton
          icon="add_circle"
          title="Докупить устройство"
          meta="+слот"
          onClick={() => navigate("/subscription/increase")}
        />
        {trafficResetPrice > 0 && (
          <ActionButton
            icon="refresh"
            title="Сбросить трафик"
            meta={`${trafficResetPrice} ₽`}
            onClick={() => navigate("/payment?type=traffic_reset")}
          />
        )}
      </div>

      {appSheet && (
        <div
          onClick={() => !linking && setAppSheet(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(8,6,4,0.7)",
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            zIndex: 40,
            animation: "blinvpnFadeIn 0.18s ease both",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 402,
              background: T.bg,
              borderTop: `1px solid ${T.border}`,
              padding: "16px 26px 28px",
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              animation: "blinvpnSheetUp 0.28s var(--ease-out) both",
            }}
          >
            <div style={{ width: 36, height: 3, borderRadius: 2, background: T.textDim, margin: "0 auto 12px" }} />
            <div style={{ fontWeight: 600, fontSize: 17, color: T.text, marginBottom: 2 }}>
              Добавить подписку
            </div>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 8, lineHeight: 1.4 }}>
              Выберите приложение — подписка добавится автоматически.
            </div>
            {(
              [
                { app: "incy", title: "Incy", sub: "Рекомендуем", primary: true },
                { app: "happ", title: "Happ", sub: "Популярное", primary: false },
                { app: "other", title: "Другое приложение", sub: "Скопировать ссылку", primary: false },
              ] as const
            ).map((row) => (
              <button
                key={row.app}
                type="button"
                disabled={linking != null}
                onClick={() => void pickApp(row.app)}
                className="blin-press"
                style={{
                  ...btnReset,
                  width: "100%",
                  minHeight: 56,
                  padding: "10px 16px",
                  borderRadius: T.radius.lg,
                  border: row.primary ? "none" : `1px solid ${T.border}`,
                  background: row.primary ? T.orange : T.surface,
                  color: row.primary ? "#fff" : T.text,
                  textAlign: "left",
                  cursor: linking ? "wait" : "pointer",
                  opacity: linking && linking !== row.app ? 0.5 : 1,
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 15 }}>
                  {linking === row.app ? "Открываем…" : row.title}
                </div>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>{row.sub}</div>
              </button>
            ))}
            {linkErr ? (
              <div style={{ fontSize: 12, color: T.danger, textAlign: "center", marginTop: 4 }}>{linkErr}</div>
            ) : null}
            <Btn variant="ghost" onClick={() => setAppSheet(false)} style={{ marginTop: 4 }}>
              Отмена
            </Btn>
          </div>
        </div>
      )}
    </Screen>
  );
}
