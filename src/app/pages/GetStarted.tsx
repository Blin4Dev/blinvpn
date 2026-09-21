import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Btn, MSIcon, PageHeader, Screen, Surface, T, btnReset } from "../components/ui";
import { fetchAppLink, fetchPlans, openDeepLink, plansToPriceMap } from "../utils/api";
import { deviceWord, estimateDevicePrice } from "../utils/devices";

type DeviceKind = "android" | "ios" | "windows" | "macos" | "linux" | "android_tv";
type AppKind = "incy" | "happ" | "other";

const MAX_DEVICES = 20;

const DEVICE_TITLE: Record<DeviceKind, string> = {
  android: "Android",
  ios: "iOS",
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  android_tv: "Android TV",
};

const HAPP_INSTALL: Record<DeviceKind, string> = {
  android: "https://play.google.com/store/apps/details?id=com.happproxy&hl=ru",
  ios: "https://apps.apple.com/ru/app/happ-proxy-utility-plus/id6746188973",
  windows: "https://github.com/Happ-proxy/happ-desktop/releases/latest/download/setup-Happ.x64.exe",
  macos: "https://apps.apple.com/ru/app/happ-proxy-utility-plus/id6746188973",
  linux: "https://github.com/Happ-proxy/happ-desktop/releases/latest/",
  android_tv: "https://play.google.com/store/apps/details?id=com.happproxy",
};

const INCY_INSTALL: Record<DeviceKind, string> = {
  android: "https://play.google.com/store/apps/details?id=llc.itdev.incy",
  ios: "https://apps.apple.com/ru/app/incy/id6756943388",
  windows: "https://github.com/INCY-DEV/incy-platforms/releases/latest/download/incy-windows-setup.exe",
  macos: "https://apps.apple.com/ru/app/incy/id6756943388",
  linux: "https://github.com/INCY-DEV/incy-platforms/releases/latest/download/incy-linux-x64.deb",
  android_tv: "https://play.google.com/store/apps/details?id=llc.itdev.incy",
};

const APP_META: Record<AppKind, { title: string; sub: string; img?: string; icon?: string; recommended?: boolean }> = {
  incy: { title: "Incy", sub: "Рекомендуем", img: "/assets/incy.png", recommended: true },
  happ: { title: "Happ", sub: "Популярное", img: "/assets/happ.png" },
  other: { title: "Другое приложение", sub: "Ссылка на подписку", icon: "link" },
};

function detectDeviceKind(): DeviceKind {
  if (typeof navigator === "undefined") return "linux";
  const ua = navigator.userAgent || "";
  if (/Android/i.test(ua) && /TV|AFT|BRAVIA|GoogleTV/i.test(ua)) return "android_tv";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Win/i.test(ua)) return "windows";
  if (/Mac/i.test(ua)) return "macos";
  return "linux";
}

function installUrl(app: AppKind, device: DeviceKind): string | null {
  if (app === "happ") return HAPP_INSTALL[device];
  if (app === "incy") return INCY_INSTALL[device];
  return null;
}

export default function GetStarted() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [device, setDevice] = useState<DeviceKind>("linux");
  const [devices, setDevices] = useState(1);
  const [priceMap, setPriceMap] = useState<Record<number, number>>({ 1: 99, 2: 169, 3: 229, 5: 349 });
  const [extraPrice, setExtraPrice] = useState(40);
  const [linking, setLinking] = useState(false);
  const [linkErr, setLinkErr] = useState("");

  const step = Math.min(6, Math.max(1, parseInt(searchParams.get("step") || "1", 10)));
  const flow = (searchParams.get("flow") || "trial") as "trial" | "purchase";
  const trialUsed = searchParams.get("trialUsed") || "0";
  const appParam = searchParams.get("app") as AppKind | null;
  const selectedApp: AppKind | null =
    appParam === "incy" || appParam === "happ" || appParam === "other" ? appParam : null;

  const needsPayment = flow === "purchase" && trialUsed === "1";

  useEffect(() => {
    setDevice(detectDeviceKind());
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const data = await fetchPlans();
        setPriceMap(plansToPriceMap(data.plans));
        setExtraPrice(data.extra_device_price || 40);
      } catch {
        /* keep */
      }
    })();
  }, []);

  // Пропуск оплаты, если не нужна; без выбранного приложения — назад к выбору
  useEffect(() => {
    if (step === 4 && !needsPayment) {
      setSearchParams({ step: "5", flow, trialUsed, ...(selectedApp ? { app: selectedApp } : {}) }, { replace: true });
    }
  }, [step, needsPayment, flow, trialUsed, selectedApp, setSearchParams]);

  useEffect(() => {
    if ((step === 3 || step === 5) && !selectedApp) {
      setSearchParams({ step: "2", flow, trialUsed }, { replace: true });
    }
  }, [step, selectedApp, flow, trialUsed, setSearchParams]);

  const setStep = (n: number, extra?: Record<string, string>) => {
    setSearchParams({
      step: String(n),
      flow,
      trialUsed,
      ...(selectedApp ? { app: selectedApp } : {}),
      ...extra,
    });
  };

  const goBack = () => {
    if (step <= 1) {
      navigate("/");
      return;
    }
    if (step === 5 && !needsPayment) {
      setStep(3);
      return;
    }
    if (step === 5 && needsPayment) {
      setStep(4);
      return;
    }
    setStep(step - 1);
  };

  const price = estimateDevicePrice(devices, priceMap, extraPrice, 1);
  const deviceLabel = DEVICE_TITLE[device];
  const appTitle = selectedApp ? APP_META[selectedApp].title : "приложение";

  const addSubscription = async () => {
    if (!selectedApp || linking) return;
    setLinking(true);
    setLinkErr("");
    try {
      const res = await fetchAppLink(selectedApp);
      openDeepLink(res);
    } catch (e) {
      setLinkErr(e instanceof Error ? e.message : "Не удалось получить ссылку");
    } finally {
      setLinking(false);
    }
  };

  const openInstall = () => {
    if (!selectedApp) return;
    const url = installUrl(selectedApp, device);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  // ─── Step 1: welcome ─────────────────────────────────────────────────────
  if (step === 1) {
    return (
      <Screen>
        <PageHeader title="Настройка" onBack={goBack} />
        <div style={{ textAlign: "center", marginTop: 24 }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: T.text, letterSpacing: "-0.02em" }}>
            Давайте начнём!
          </div>
          <div style={{ fontSize: 16, color: T.textMuted, marginTop: 10, lineHeight: 1.45 }}>
            Настройка на {deviceLabel} займёт не больше пары минут
          </div>
          <img
            src="/assets/logo.png"
            alt=""
            draggable={false}
            style={{ width: 180, height: 180, objectFit: "contain", margin: "36px auto 0", display: "block" }}
          />
        </div>
        <div style={{ marginTop: "auto", paddingTop: 32 }}>
          <Btn onClick={() => setStep(2)}>Начать настройку</Btn>
        </div>
      </Screen>
    );
  }

  // ─── Step 2: choose app ──────────────────────────────────────────────────
  if (step === 2) {
    return (
      <Screen>
        <PageHeader title="Настройка" onBack={goBack} />
        <div style={{ fontSize: 22, fontWeight: 600, color: T.text, marginBottom: 8 }}>Приложение</div>
        <div style={{ fontSize: 14, color: T.textMuted, marginBottom: 20, lineHeight: 1.45 }}>
          Выберите клиент — дальше установим его и добавим подписку
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {(["incy", "happ", "other"] as const).map((app) => {
            const m = APP_META[app];
            const active = selectedApp === app;
            return (
              <button
                key={app}
                type="button"
                className="blin-press"
                onClick={() => setStep(3, { app })}
                style={{
                  ...btnReset,
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  width: "100%",
                  minHeight: 64,
                  padding: "12px 16px",
                  borderRadius: T.radius.lg,
                  border: active || m.recommended ? `1px solid ${T.orange}` : `1px solid ${T.border}`,
                  background: T.surface,
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    overflow: "hidden",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: T.surfaceRaised,
                    flexShrink: 0,
                  }}
                >
                  {m.img ? (
                    <img src={m.img} alt="" style={{ width: 40, height: 40, objectFit: "cover" }} />
                  ) : (
                    <MSIcon name={m.icon || "link"} style={{ color: T.text }} />
                  )}
                </span>
                <span style={{ flex: 1 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 16, color: T.text }}>{m.title}</span>
                    {m.recommended ? (
                      <span style={{ fontSize: 11, fontWeight: 600, color: T.orange }}>рекомендуем</span>
                    ) : null}
                  </span>
                  <span style={{ display: "block", fontSize: 12, color: T.textMuted, marginTop: 2 }}>{m.sub}</span>
                </span>
                <MSIcon name="chevron_right" style={{ color: T.orange }} />
              </button>
            );
          })}
        </div>
      </Screen>
    );
  }

  // ─── Step 3: install ─────────────────────────────────────────────────────
  if (step === 3) {
    const canInstall = selectedApp === "incy" || selectedApp === "happ";
    return (
      <Screen>
        <PageHeader title="Настройка" onBack={goBack} />
        <div style={{ fontSize: 22, fontWeight: 600, color: T.text, marginBottom: 8 }}>Установка</div>
        <div style={{ fontSize: 14, color: T.textMuted, marginBottom: 20, lineHeight: 1.45 }}>
          {canInstall
            ? `Установите ${appTitle} на ${deviceLabel}, затем нажмите «Далее»`
            : "Установите любое VPN-приложение с поддержкой подписки, затем нажмите «Далее»"}
        </div>
        <img
          src="/assets/logo.png"
          alt=""
          draggable={false}
          style={{ width: 160, height: 160, objectFit: "contain", margin: "12px auto", display: "block", opacity: 0.9 }}
        />
        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 10, paddingTop: 24 }}>
          {canInstall ? (
            <Btn onClick={openInstall}>Скачать {appTitle}</Btn>
          ) : null}
          <Btn
            variant={canInstall ? "secondary" : "primary"}
            onClick={() => setStep(needsPayment ? 4 : 5)}
          >
            Далее
          </Btn>
        </div>
      </Screen>
    );
  }

  // ─── Step 4: payment (purchase only) ─────────────────────────────────────
  if (step === 4) {
    return (
      <Screen>
        <PageHeader title="Настройка" onBack={goBack} />
        <div style={{ textAlign: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 22, fontWeight: 600, color: T.text }}>Оплата</div>
          <div style={{ fontSize: 14, color: T.textMuted, marginTop: 8, lineHeight: 1.45 }}>
            Оформите подписку — после оплаты добавим её в приложение
          </div>
        </div>

        <Surface padded style={{ marginTop: 20 }}>
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
              <div style={{ fontSize: 13, color: T.orange, marginTop: 2 }}>{price} ₽ / мес</div>
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

        <div style={{ marginTop: "auto", paddingTop: 24 }}>
          <Btn
            onClick={() => {
              const ret = encodeURIComponent(
                `/subscription/start?step=5&flow=${flow}&trialUsed=${trialUsed}${selectedApp ? `&app=${selectedApp}` : ""}`,
              );
              navigate(`/payment?devices=${devices}&return=${ret}`);
            }}
          >
            Оплатить {price} ₽
          </Btn>
        </div>
      </Screen>
    );
  }

  // ─── Step 5: add subscription (no app picker) ─────────────────────────────
  if (step === 5) {
    return (
      <Screen>
        <PageHeader title="Настройка" onBack={goBack} />
        <div style={{ fontSize: 22, fontWeight: 600, color: T.text, marginBottom: 8 }}>Подписка</div>
        <div style={{ fontSize: 14, color: T.textMuted, marginBottom: 20, lineHeight: 1.45 }}>
          Добавьте подписку в {appTitle} одной кнопкой
        </div>
        <img
          src="/assets/logo.png"
          alt=""
          draggable={false}
          style={{ width: 160, height: 160, objectFit: "contain", margin: "12px auto", display: "block", opacity: 0.9 }}
        />
        {linkErr ? (
          <div style={{ color: T.danger, fontSize: 13, textAlign: "center", marginTop: 12 }}>{linkErr}</div>
        ) : null}
        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 10, paddingTop: 24 }}>
          <Btn disabled={linking || !selectedApp} onClick={() => void addSubscription()}>
            {linking ? "Открываем…" : "Добавить подписку"}
          </Btn>
          <Btn variant="secondary" onClick={() => setStep(6)}>
            Далее
          </Btn>
        </div>
      </Screen>
    );
  }

  // ─── Step 6: done ────────────────────────────────────────────────────────
  return (
    <Screen>
      <PageHeader title="Настройка" onBack={() => navigate("/")} />
      <div style={{ textAlign: "center", marginTop: 48 }}>
        <MSIcon name="check_circle" style={{ fontSize: 64, color: T.orange }} />
        <div style={{ fontSize: 22, fontWeight: 600, color: T.text, marginTop: 16 }}>Готово!</div>
        <div style={{ fontSize: 14, color: T.textMuted, marginTop: 8, lineHeight: 1.45 }}>
          Подписка настроена. Можно пользоваться VPN.
        </div>
      </div>
      <div style={{ marginTop: "auto", paddingTop: 32 }}>
        <Btn onClick={() => navigate("/", { replace: true })}>На главную</Btn>
      </div>
    </Screen>
  );
}
