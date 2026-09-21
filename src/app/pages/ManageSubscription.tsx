import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { MSIcon } from "../components/ui";
import { useAppError } from "../components/ErrorModal";
import { useSmartBack } from "../utils/navigation";
import { appFetch, fetchAppLink, fetchConfig, fetchPlans, freezeSubscription, minPlanPrice, openDeepLink, unfreezeSubscription } from "../utils/api";

/** Иконки Material Symbols (Google Fonts) */
function ShoppingBagOutline24() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"
        stroke="#FFFFFF"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="3" y1="6" x2="21" y2="6" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round" />
      <path
        d="M16 10a4 4 0 01-8 0"
        stroke="#FFFFFF"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusOutline24() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 5v14M5 12h14" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}

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

const btnReset: React.CSSProperties = {
  boxSizing: "border-box",
  WebkitTapHighlightColor: "transparent",
  touchAction: "manipulation",
  outline: "none",
  appearance: "none",
  WebkitAppearance: "none",
};

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

  // Приход из онбординг-модалки «Продолжить настройку» — сразу открываем
  // выбор приложения для добавления подписки.
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
      } catch {
        /* keep 99 */
      }
      try {
        const cfg = await fetchConfig();
        const p = Number((cfg as { trafficResetPrice?: number }).trafficResetPrice ?? 0);
        if (Number.isFinite(p)) setTrafficResetPrice(p);
      } catch {
        /* без сброса трафика */
      }
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
      } catch {
        /* show placeholder */
      } finally {
        setLoaded(true);
      }
    })();
  }, [navigate, reloadTick]);

  const toggleFreeze = async () => {
    if (busy) return;
    if (!frozen && !window.confirm("Заморозить подписку? Отсчёт дней остановится, VPN временно отключится. Разморозить можно раз в сутки, максимум на 30 дней — оплаченное время не сгорит.")) return;
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

  const page: React.CSSProperties = {
    position: "relative",
    boxSizing: "border-box",
    width: "402px",
    height: "803px",
    margin: "0 auto",
    background: "#212121",
    fontFamily: "'Inter', sans-serif",
    overflow: "hidden",
    flexShrink: 0,
    WebkitFontSmoothing: "antialiased",
    MozOsxFontSmoothing: "grayscale",
  };

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        boxSizing: "border-box",
        minHeight: "100vh",
        background: "#111",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <div style={page}>
        {/* Кнопка назад */}
        <button
          type="button"
          onClick={goBack}
          style={{
            ...btnReset,
            position: "absolute",
            width: "37px",
            height: "37px",
            left: "26px",
            top: "26px",
            padding: 0,
            border: "none",
            borderRadius: "50%",
            background: "#313131",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
          aria-label="Назад"
        >
          <MSIcon name="chevron_left" style={{ fontSize: 24, color: "#FFFFFF" }} />
        </button>

        {/* Заголовок «Подписка» */}
        <div
          style={{
            position: "absolute",
            left: "73px",
            top: "28px",
            height: "37px",
            display: "flex",
            alignItems: "center",
            fontWeight: 600,
            fontSize: "27px",
            lineHeight: "33px",
            color: "#FFFFFF",
            whiteSpace: "nowrap",
          }}
        >
          Подписка
        </div>

        {/* Карточка таймера — контент по центру через flex */}
        <div
          style={{
            position: "absolute",
            width: "350px",
            height: "115px",
            left: "26px",
            top: "87px",
            background: "#333333",
            borderRadius: "30px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: "6px",
            padding: "0 27px",
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              fontWeight: 500,
              fontSize: "13px",
              lineHeight: "16px",
              color: "#FFFFFF",
              opacity: 0.53,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            {frozen ? "На паузе" : "Осталось"}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              flexWrap: "nowrap",
              fontWeight: 700,
              fontSize: "32px",
              lineHeight: "39px",
              color: frozen ? "#7FB2FF" : "#F18726",
              gap: "2px",
            }}
          >
            {frozen ? (
              <span>❄ {frozenDays ?? days} дн.</span>
            ) : (
              <>
                <span>{days}</span>
                <span style={{ fontSize: "22px", fontWeight: 700, marginLeft: "2px", marginRight: "8px" }}>д</span>
                <span>
                  {pad2(h)} : {pad2(m)} : {pad2(s)}
                </span>
              </>
            )}
          </div>
          <div
            style={{
              fontWeight: 500,
              fontSize: "13px",
              lineHeight: "16px",
              color: "#FFFFFF",
              opacity: 0.53,
            }}
          >
            {frozen ? "Подписка заморожена — дни не расходуются" : `Действует до ${untilLabel}`}
          </div>
        </div>

        {/* ГЛАВНОЕ: добавить подписку в приложение (то, ради чего пришли) */}
        <button
          type="button"
          onClick={() => setAppSheet(true)}
          style={{
            ...btnReset,
            position: "absolute",
            width: "350px",
            height: "64px",
            left: "26px",
            top: "216px",
            padding: "0 20px",
            border: "none",
            background: "#F18726",
            borderRadius: "22px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <MSIcon name="download" style={{ fontSize: 30, color: "#FFFFFF", flexShrink: 0 }} />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "2px", textAlign: "left" }}>
            <span style={{ fontWeight: 700, fontSize: "18px", lineHeight: "21px", color: "#FFFFFF" }}>Добавить подписку</span>
            <span style={{ fontWeight: 400, fontSize: "13px", color: "#FFFFFF", opacity: 0.75 }}>подключиться в приложении</span>
          </div>
          <MSIcon name="chevron_right" style={{ fontSize: 24, color: "#FFFFFF", flexShrink: 0 }} />
        </button>

        {/* Продлить подписку */}
        <button
          type="button"
          onClick={() => navigate("/subscription/extend")}
          style={{
            ...btnReset, position: "absolute", width: "350px", height: "50px", left: "26px", top: "292px",
            padding: "0 19px", border: "none", background: "#333333", borderRadius: "21px",
            cursor: "pointer", display: "flex", alignItems: "center", gap: "10px",
          }}
        >
          <ShoppingBagOutline24 />
          <span style={{ flex: 1, fontWeight: 600, fontSize: "16px", lineHeight: "19px", color: "#FFFFFF", textAlign: "left" }}>
            Продлить подписку
          </span>
          <span style={{ fontWeight: 500, fontSize: "15px", color: "#FFFFFF", opacity: 0.7, whiteSpace: "nowrap" }}>
            от {minPrice} ₽
          </span>
        </button>

        {/* Подключённые устройства */}
        <button
          type="button"
          onClick={() => navigate("/subscription/devices")}
          style={{
            ...btnReset, position: "absolute", width: "350px", height: "50px", left: "26px", top: "354px",
            padding: "0 16px 0 19px", border: "none", background: "#333333", borderRadius: "21px",
            cursor: "pointer", display: "flex", alignItems: "center", gap: "10px",
          }}
        >
          <MSIcon name="computer" style={{ fontSize: 24, color: "#FFFFFF", flexShrink: 0 }} />
          <span style={{ flex: 1, fontWeight: 600, fontSize: "16px", lineHeight: "19px", color: "#FFFFFF", textAlign: "left" }}>
            Мои устройства
          </span>
          <span style={{ fontSize: "13px", color: "#FFFFFF", opacity: 0.5, whiteSpace: "nowrap" }}>{devicesSummary}</span>
          <MSIcon name="chevron_right" style={{ fontSize: 22, color: "#FFFFFF", opacity: 0.6, flexShrink: 0 }} />
        </button>

        {/* ── Дополнительно ── */}
        <div style={{ position: "absolute", left: "34px", top: "426px", fontSize: "12px", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "#7D7D7D" }}>
          Дополнительно
        </div>

        {/* Докупить устройство (увеличить лимит, не меняя срок) */}
        <button
          type="button"
          onClick={() => navigate("/subscription/increase")}
          style={{
            ...btnReset, position: "absolute", width: "350px", height: "48px", left: "26px", top: "450px",
            padding: "0 19px", border: "none", background: "rgba(51,51,51,0.6)", borderRadius: "18px",
            cursor: "pointer", display: "flex", alignItems: "center", gap: "10px",
          }}
        >
          <PlusOutline24 />
          <span style={{ flex: 1, fontWeight: 500, fontSize: "15px", lineHeight: "18px", color: "#E9E9E9", textAlign: "left" }}>
            Докупить устройство
          </span>
          <span style={{ fontSize: "12px", color: "#FFFFFF", opacity: 0.45, whiteSpace: "nowrap" }}>+слот, срок не меняется</span>
        </button>

        {/* Досрочный сброс трафика (если включено в панели) */}
        {trafficResetPrice > 0 && (
          <button
            type="button"
            onClick={() => navigate("/payment?type=traffic_reset")}
            style={{
              ...btnReset, position: "absolute", width: "350px", height: "48px", left: "26px", top: "506px",
              padding: "0 19px", border: "none", background: "rgba(51,51,51,0.6)", borderRadius: "18px",
              cursor: "pointer", display: "flex", alignItems: "center", gap: "10px",
            }}
          >
            <MSIcon name="refresh" style={{ fontSize: 22, color: "#C9C9C9" }} />
            <span style={{ flex: 1, fontWeight: 500, fontSize: "15px", lineHeight: "18px", color: "#E9E9E9", textAlign: "left" }}>
              Сбросить трафик
            </span>
            <span style={{ fontSize: "13px", color: "#FFFFFF", opacity: 0.6, whiteSpace: "nowrap" }}>{trafficResetPrice} ₽</span>
          </button>
        )}

        {/* Заморозить / Разморозить подписку (рабочая) */}
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggleFreeze()}
          style={{
            ...btnReset, position: "absolute", width: "350px", height: "48px", left: "26px",
            top: trafficResetPrice > 0 ? "562px" : "506px",
            padding: "0 19px", border: "none",
            background: frozen ? "rgba(127,178,255,0.22)" : "rgba(51,51,51,0.6)",
            borderRadius: "18px", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1,
            display: "flex", alignItems: "center", gap: "10px",
          }}
        >
          <MSIcon name={frozen ? "play_circle" : "ac_unit"} style={{ fontSize: 22, color: frozen ? "#7FB2FF" : "#C9C9C9" }} />
          <span style={{ flex: 1, fontWeight: 500, fontSize: "15px", lineHeight: "18px", color: frozen ? "#BFD8FF" : "#E9E9E9", textAlign: "left" }}>
            {busy ? "Подождите…" : frozen ? "Разморозить подписку" : "Заморозить подписку"}
          </span>
        </button>

        {/* Нижняя шторка: выбор приложения для добавления подписки */}
        {appSheet && (
          <div
            onClick={() => !linking && setAppSheet(false)}
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.55)",
              display: "flex",
              alignItems: "flex-end",
              zIndex: 20,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "100%",
                background: "#2A2A2A",
                borderTopLeftRadius: "24px",
                borderTopRightRadius: "24px",
                padding: "18px 20px 26px",
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: "18px", color: "#FFFFFF", marginBottom: "2px" }}>
                Добавить подписку
              </div>
              <div style={{ fontSize: "13px", color: "#FFFFFF", opacity: 0.55, marginBottom: "6px" }}>
                Выберите приложение — подписка добавится автоматически.
              </div>
              {([
                { app: "incy", title: "Incy", sub: "рекомендуем" },
                { app: "happ", title: "Happ", sub: "популярное" },
                { app: "other", title: "Другое приложение", sub: "скопировать ссылку" },
              ] as const).map((row) => (
                <button
                  key={row.app}
                  type="button"
                  disabled={linking != null}
                  onClick={() => void pickApp(row.app)}
                  style={{
                    ...btnReset,
                    width: "100%",
                    height: "56px",
                    borderRadius: "18px",
                    border: "none",
                    background: row.app === "incy" ? "rgba(241,135,38,0.85)" : "#3A3A3A",
                    color: "#FFFFFF",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    justifyContent: "center",
                    padding: "0 18px",
                    cursor: linking ? "wait" : "pointer",
                    opacity: linking && linking !== row.app ? 0.6 : 1,
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: "16px" }}>
                    {linking === row.app ? "Открываем…" : row.title}
                  </span>
                  <span style={{ fontSize: "12px", opacity: 0.6 }}>{row.sub}</span>
                </button>
              ))}
              {linkErr && (
                <div style={{ fontSize: "12px", color: "#FF6B6B", textAlign: "center" }}>{linkErr}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}