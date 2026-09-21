import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Btn, MSIcon, PageHeader, Screen, Surface, T, btnReset } from "../components/ui";
import { useAppError } from "../components/ErrorModal";
import { useSmartBack } from "../utils/navigation";
import {
  appFetch,
  fetchAppLink,
  fetchConfig,
  fetchPlans,
  freezeSubscription,
  minPlanPrice,
  openDeepLink,
  unfreezeSubscription,
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

function ActionRow({
  icon,
  title,
  meta,
  onClick,
  accent,
}: {
  icon: string;
  title: string;
  meta?: string;
  onClick: () => void;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="blin-press"
      style={{
        ...btnReset,
        width: "100%",
        minHeight: 54,
        padding: "0 16px",
        border: `1px solid ${accent ? "transparent" : T.border}`,
        background: accent
          ? `linear-gradient(180deg, ${T.orangeBright} 0%, ${T.orange} 100%)`
          : T.surface,
        borderRadius: T.radius.lg,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 12,
        boxShadow: accent ? `0 8px 24px ${T.orangeGlow}` : undefined,
      }}
    >
      <MSIcon name={icon} style={{ fontSize: 24, color: accent ? "#fff" : T.orange, flexShrink: 0 }} />
      <span
        style={{
          flex: 1,
          fontWeight: 600,
          fontSize: 15,
          color: accent ? "#fff" : T.text,
          textAlign: "left",
        }}
      >
        {title}
      </span>
      {meta ? (
        <span style={{ fontSize: 13, color: accent ? "rgba(255,255,255,0.75)" : T.textMuted, whiteSpace: "nowrap" }}>
          {meta}
        </span>
      ) : null}
      <MSIcon name="chevron_right" style={{ fontSize: 22, color: accent ? "rgba(255,255,255,0.8)" : T.textDim }} />
    </button>
  );
}

export default function ManageSubscription() {
  const navigate = useNavigate();
  const location = useLocation();
  const goBack = useSmartBack("/");
  const { showError } = useAppError();

  const [untilIso, setUntilIso] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [minPrice, setMinPrice] = useState(99);
  const [devicesSummary, setDevicesSummary] = useState("—");
  const [trafficResetPrice, setTrafficResetPrice] = useState(0);
  const [appSheet, setAppSheet] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [linkErr, setLinkErr] = useState("");
  const [frozen, setFrozen] = useState(false);
  const [frozenDays, setFrozenDays] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

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
          frozen?: boolean;
          key?: { devices_limit?: number; days_left?: number | null; frozen?: boolean } | null;
        }>("/subscription");
        if (!data.until) {
          setLoaded(true);
          navigate("/subscription/start", { replace: true });
          return;
        }
        setUntilIso(data.until);
        setFrozen(Boolean(data.frozen || data.key?.frozen));
        if (typeof data.key?.days_left === "number") setFrozenDays(data.key.days_left);
        const limit = data.key?.devices_limit;
        if (limit != null) setDevicesSummary(`лимит ${limit}`);
      } catch { /* placeholder */ } finally {
        setLoaded(true);
      }
    })();
  }, [navigate, reloadTick]);

  const toggleFreeze = async () => {
    if (busy) return;
    if (
      !frozen &&
      !window.confirm(
        "Заморозить подписку? Отсчёт дней остановится, VPN временно отключится. Разморозить можно раз в сутки, максимум на 30 дней — оплаченное время не сгорит.",
      )
    ) {
      return;
    }
    setBusy(true);
    const res = frozen ? await unfreezeSubscription() : await freezeSubscription();
    setBusy(false);
    if (res.ok) setReloadTick((t) => t + 1);
    else showError(res.error || "Не удалось выполнить действие. Попробуйте позже.");
  };

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

      <Surface
        style={{
          padding: "18px 20px",
          marginBottom: 14,
          background: frozen ? T.infoSoft : T.surface,
          borderColor: frozen ? "rgba(127,178,255,0.25)" : T.border,
        }}
      >
        <div
          style={{
            fontWeight: 600,
            fontSize: 12,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: T.textMuted,
            marginBottom: 6,
          }}
        >
          {frozen ? "На паузе" : "Осталось"}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            fontWeight: 800,
            fontSize: 34,
            letterSpacing: "-0.03em",
            color: frozen ? T.info : T.orange,
            gap: 4,
            lineHeight: 1.1,
          }}
        >
          {frozen ? (
            <span>❄ {frozenDays ?? days} дн.</span>
          ) : (
            <>
              <span>{days}</span>
              <span style={{ fontSize: 20, fontWeight: 700, marginRight: 6 }}>д</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {pad2(h)}:{pad2(m)}:{pad2(s)}
              </span>
            </>
          )}
        </div>
        <div style={{ marginTop: 8, fontSize: 13, color: T.textMuted }}>
          {frozen ? "Подписка заморожена — дни не расходуются" : `Действует до ${untilLabel}`}
        </div>
      </Surface>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <ActionRow
          accent
          icon="download"
          title="Добавить подписку"
          meta="в приложение"
          onClick={() => setAppSheet(true)}
        />
        <ActionRow
          icon="shopping_bag"
          title="Продлить подписку"
          meta={`от ${minPrice} ₽`}
          onClick={() => navigate("/subscription/extend")}
        />
        <ActionRow
          icon="devices"
          title="Мои устройства"
          meta={devicesSummary}
          onClick={() => navigate("/subscription/devices")}
        />
      </div>

      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: T.textDim,
          margin: "22px 4px 10px",
        }}
      >
        Дополнительно
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <ActionRow
          icon="add_circle"
          title="Докупить устройство"
          meta="+слот"
          onClick={() => navigate("/subscription/increase")}
        />
        {trafficResetPrice > 0 && (
          <ActionRow
            icon="refresh"
            title="Сбросить трафик"
            meta={`${trafficResetPrice} ₽`}
            onClick={() => navigate("/payment?type=traffic_reset")}
          />
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggleFreeze()}
          className="blin-press"
          style={{
            ...btnReset,
            width: "100%",
            minHeight: 52,
            padding: "0 16px",
            border: `1px solid ${frozen ? "rgba(127,178,255,0.3)" : T.border}`,
            background: frozen ? T.infoSoft : T.surface,
            borderRadius: T.radius.lg,
            cursor: busy ? "wait" : "pointer",
            opacity: busy ? 0.6 : 1,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <MSIcon
            name={frozen ? "play_circle" : "ac_unit"}
            style={{ fontSize: 22, color: frozen ? T.info : T.textMuted }}
          />
          <span
            style={{
              flex: 1,
              fontWeight: 600,
              fontSize: 15,
              color: frozen ? T.info : T.text,
              textAlign: "left",
            }}
          >
            {busy ? "Подождите…" : frozen ? "Разморозить подписку" : "Заморозить подписку"}
          </span>
        </button>
      </div>

      {appSheet && (
        <div
          onClick={() => !linking && setAppSheet(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(8,6,4,0.72)",
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
              background: T.surface,
              borderTopLeftRadius: 28,
              borderTopRightRadius: 28,
              border: `1px solid ${T.borderStrong}`,
              borderBottom: "none",
              padding: "18px 20px 28px",
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              animation: "blinvpnSheetUp 0.3s var(--ease-out) both",
            }}
          >
            <div style={{ width: 40, height: 4, borderRadius: 2, background: T.textDim, margin: "0 auto 8px" }} />
            <div style={{ fontWeight: 700, fontSize: 18, color: T.text, letterSpacing: "-0.02em" }}>
              Добавить подписку
            </div>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 4 }}>
              Выберите приложение — подписка добавится автоматически.
            </div>
            {(
              [
                { app: "incy", title: "Incy", sub: "рекомендуем" },
                { app: "happ", title: "Happ", sub: "популярное" },
                { app: "other", title: "Другое приложение", sub: "скопировать ссылку" },
              ] as const
            ).map((row) => (
              <Btn
                key={row.app}
                variant={row.app === "incy" ? "primary" : "secondary"}
                disabled={linking != null}
                onClick={() => void pickApp(row.app)}
                style={{
                  flexDirection: "column",
                  alignItems: "flex-start",
                  justifyContent: "center",
                  minHeight: 58,
                  gap: 2,
                  opacity: linking && linking !== row.app ? 0.55 : 1,
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 16 }}>
                  {linking === row.app ? "Открываем…" : row.title}
                </span>
                <span style={{ fontSize: 12, opacity: 0.7, fontWeight: 500 }}>{row.sub}</span>
              </Btn>
            ))}
            {linkErr && (
              <div style={{ fontSize: 12, color: T.danger, textAlign: "center" }}>{linkErr}</div>
            )}
          </div>
        </div>
      )}
    </Screen>
  );
}
