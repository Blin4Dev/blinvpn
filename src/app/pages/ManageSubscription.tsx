import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ActionButton, PageHeader, Screen, SectionLabel, T } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { appFetch, fetchConfig } from "../utils/api";
import { formatDateRu } from "../utils/date";
import SetupSheet from "../components/SetupSheet";

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
  // Закончившаяся (ещё не удалённая) подписка: дата окончания и автоудаления
  const [expiredAt, setExpiredAt] = useState<string | null>(null);
  const [deleteAt, setDeleteAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [trafficResetPrice, setTrafficResetPrice] = useState(0);
  // Продление запрещено администратором: кнопки «Продлить» нет
  const [noRenew, setNoRenew] = useState(false);
  const [appSheet, setAppSheet] = useState(false);

  const closeSheet = () => {
    setAppSheet(false);
    // Убираем ?setup=1, чтобы окно не открылось снова при возврате на страницу
    if (new URLSearchParams(location.search).has("setup")) navigate("/subscription", { replace: true });
  };

  useEffect(() => {
    if (new URLSearchParams(location.search).get("setup") === "1") {
      setAppSheet(true);
    }
  }, [location.search]);

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await fetchConfig();
        const p = Number((cfg as { trafficResetPrice?: number }).trafficResetPrice ?? 0);
        if (Number.isFinite(p)) setTrafficResetPrice(p);
      } catch { /* без сброса */ }
      try {
        const data = await appFetch<{
          status?: string;
          until?: string | null;
          key?: { devices_limit?: number; days_left?: number | null; no_renew?: boolean } | null;
          expired_key?: { expiry_date?: string | null } | null;
          delete_at?: string | null;
        }>("/subscription");
        if (data.status === "expired") {
          // Экран «Истекла» показываем даже если сервер не прислал дату
          setExpiredAt(data.expired_key?.expiry_date || new Date().toISOString());
          setDeleteAt(data.delete_at || null);
          return;
        }
        if (!data.until) {
          // Подписки нет (или уже удалена) — на главную, там кнопка оформления
          setLoaded(true);
          navigate("/", { replace: true });
          return;
        }
        setUntilIso(data.until);
        setNoRenew(!!data.key?.no_renew);
      } catch { /* placeholder */ } finally {
        setLoaded(true);
      }
    })();
  }, [navigate]);

  const validUntil = useMemo(
    () => (untilIso ? new Date(untilIso) : new Date(Date.now() + 86400000)),
    [untilIso],
  );
  const { days, h, m, s, ms } = useCountdown(validUntil);

  // Подписка закончилась, пока страница открыта — переключаемся на экран «Истекла»
  useEffect(() => {
    if (untilIso && ms <= 0 && !expiredAt) {
      setExpiredAt(untilIso);
      setDeleteAt(new Date(new Date(untilIso).getTime() + 7 * 86_400_000).toISOString());
    }
  }, [ms, untilIso, expiredAt]);

  const untilLabel = untilIso
    ? formatDateRu(untilIso)
    : loaded
      ? "нет активной подписки"
      : "загрузка…";

  if (expiredAt) {
    const deleteIn = deleteAt ? Math.max(1, Math.ceil((new Date(deleteAt).getTime() - Date.now()) / 86_400_000)) : null;
    const dw = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? "день" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "дня" : "дней");
    return (
      <Screen>
        <PageHeader title="Подписка" onBack={goBack} />
        <div style={{ marginBottom: 22 }}>
          <div style={{ fontSize: 12, fontWeight: 500, letterSpacing: "0.04em", textTransform: "uppercase", color: T.textDim, marginBottom: 8 }}>
            Статус
          </div>
          <div style={{ fontWeight: 700, fontSize: 36, letterSpacing: "-0.03em", color: T.text, lineHeight: 1 }}>Истекла</div>
          <div style={{ marginTop: 10, fontSize: 14, color: T.textMuted }}>
            Закончилась {formatDateRu(expiredAt)}
          </div>
          {deleteIn != null ? (
            <div
              style={{
                marginTop: 14,
                padding: "12px 14px",
                borderRadius: T.radius.md,
                background: T.dangerSoft,
                color: T.danger,
                fontSize: 13,
                lineHeight: 1.45,
                fontWeight: 500,
              }}
            >
              Продлите подписку — иначе через {deleteIn} {dw(deleteIn)} она будет удалена вместе с настройками в приложении.
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <ActionButton primary icon="bolt" title="Продлить подписку" onClick={() => navigate("/subscription/extend")} />
        </div>
      </Screen>
    );
  }

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
        {noRenew ? (
          <div
            style={{
              marginTop: 14,
              padding: "12px 14px",
              borderRadius: T.radius.md,
              background: T.surface,
              border: `1px solid ${T.border}`,
              color: T.textMuted,
              fontSize: 13,
              lineHeight: 1.45,
            }}
          >
            Продление этой подписки недоступно. После окончания срока она будет удалена — тогда можно будет оформить новую.
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <ActionButton
          primary
          icon="download"
          title="Добавить подписку"
          onClick={() => setAppSheet(true)}
        />
        {!noRenew && (
          <ActionButton
            icon="shopping_bag"
            title="Продлить подписку"
            onClick={() => navigate("/subscription/extend")}
          />
        )}
        <ActionButton
          icon="devices"
          title="Мои устройства"
          onClick={() => navigate("/subscription/devices")}
        />
      </div>

      <SectionLabel>Дополнительно</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <ActionButton
          icon="add_circle"
          title="Докупить устройство"
          onClick={() => navigate("/subscription/increase")}
        />
        {trafficResetPrice > 0 && (
          <ActionButton
            icon="refresh"
            title="Сбросить трафик"
            onClick={() => navigate("/payment?type=traffic_reset")}
          />
        )}
      </div>

      {appSheet && <SetupSheet onClose={closeSheet} />}
    </Screen>
  );
}
