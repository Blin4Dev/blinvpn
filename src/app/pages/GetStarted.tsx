import React, { useEffect, useMemo, useState } from "react";
import { MSIcon as MS } from "../components/ui";
import { useNavigate, useSearchParams } from "react-router-dom";
import { fetchAppLink, fetchPlans, openDeepLink, plansToPriceMap } from "../utils/api";

// ─── Платформа и ссылки Happ (всё в одном файле) ─────────────────────────────

type DeviceKind = "android" | "ios" | "windows" | "macos" | "linux" | "android_tv";

const DEVICE_TITLE: Record<DeviceKind, string> = {
  android: "Android",
  ios: "iOS",
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  android_tv: "Android TV",
};

const HAPP_INSTALL_URL: Record<DeviceKind, string> = {
  android: "https://play.google.com/store/apps/details?id=com.happproxy&hl=ru",
  ios: "https://apps.apple.com/ru/app/happ-proxy-utility-plus/id6746188973",
  windows:
    "https://github.com/Happ-proxy/happ-desktop/releases/latest/download/setup-Happ.x64.exe",
  macos: "https://apps.apple.com/ru/app/happ-proxy-utility-plus/id6746188973",
  linux: "https://github.com/Happ-proxy/happ-desktop/releases/latest/",
  android_tv: "https://play.google.com/store/apps/details?id=com.happproxy",
};

function detectDeviceKind(): DeviceKind {
  if (typeof navigator === "undefined") return "linux";
  const ua = navigator.userAgent.toLowerCase();
  if (
    /android tv|androidtv|googletv|aftb|aftm|afts|aftt|crkey|bravia|hisense|tizen|smart-tv|tv;/.test(
      ua,
    )
  ) {
    return "android_tv";
  }
  if (ua.includes("android")) return "android";
  const isIOS =
    /iphone|ipad|ipod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isIOS) return "ios";
  if (ua.includes("win")) return "windows";
  if (ua.includes("mac")) return "macos";
  if (ua.includes("linux")) return "linux";
  return "linux";
}

/** Свечение лого: плавная прогрессия от едва заметного до максимума */
const LOGO_GLOW: Record<number, string | undefined> = {
  1: undefined,

  2: [
    "drop-shadow(0px 0px 20px #F18726)",
    "drop-shadow(0px 0px 12px #F18726)",
    "drop-shadow(0px 0px 6px #F18726)",
  ].join(" "),

  3: [
    "drop-shadow(0px 0px 60px #F18726)",
    "drop-shadow(0px 0px 35px #F18726)",
    "drop-shadow(0px 0px 18px #F18726)",
    "drop-shadow(0px 0px 8px #F18726)",
  ].join(" "),

  4: [
    "drop-shadow(0px 0px 40px #F18726)",
    "drop-shadow(0px 0px 22px #F18726)",
    "drop-shadow(0px 0px 12px #F18726)",
    "drop-shadow(0px 0px 6px #F18726)",
  ].join(" "),

  5: [
    "drop-shadow(0px 0px 55px #F18726)",
    "drop-shadow(0px 0px 30px #F18726)",
    "drop-shadow(0px 0px 16px #F18726)",
    "drop-shadow(0px 0px 8px #F18726)",
  ].join(" "),
};

const btnReset: React.CSSProperties = {
  boxSizing: "border-box",
  WebkitTapHighlightColor: "transparent",
  touchAction: "manipulation",
};

const pageShell: React.CSSProperties = {
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
};

/** Нижний блок 350×135: два ряда кнопок 330×50 */
function BottomCardTwoRows(props: {
  topOrange: React.ReactNode;
  topOrangeOnClick?: () => void;
  bottomGray: React.ReactNode;
  bottomGrayOnClick?: () => void;
}) {
  return (
    <>
      <div
        style={{
          position: "absolute",
          width: "350px",
          height: "135px",
          left: "26px",
          top: "628px",
          background: "#333333",
          borderRadius: "30px",
        }}
      />
      <button
        type="button"
        onClick={props.topOrangeOnClick}
        style={{
          ...btnReset,
          position: "absolute",
          width: "330px",
          height: "50px",
          left: "36px",
          top: "642px",
          background: "#F18726",
          borderRadius: "30px",
          border: "none",
          cursor: "pointer",
        }}
      >
        <span style={{ position: "relative", display: "block", width: "100%", height: "100%" }}>
          {props.topOrange}
        </span>
      </button>
      <button
        type="button"
        onClick={props.bottomGrayOnClick}
        style={{
          ...btnReset,
          position: "absolute",
          width: "330px",
          height: "50px",
          left: "36px",
          top: "699px",
          background: "#3D3D3D",
          borderRadius: "30px",
          border: "none",
          cursor: "pointer",
        }}
      >
        <span style={{ position: "relative", display: "block", width: "100%", height: "100%" }}>
          {props.bottomGray}
        </span>
      </button>
    </>
  );
}

/** Финальный экран: один оранжевый ряд внутри 350×78 */
function BottomCardOneRow(props: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <>
      <div
        style={{
          position: "absolute",
          width: "350px",
          height: "78px",
          left: "26px",
          top: "685px",
          background: "#333333",
          borderRadius: "30px",
        }}
      />
      <button
        type="button"
        onClick={props.onClick}
        style={{
          ...btnReset,
          position: "absolute",
          width: "330px",
          height: "50px",
          left: "36px",
          top: "699px",
          background: "#F18726",
          borderRadius: "30px",
          border: "none",
          cursor: "pointer",
        }}
      >
        <span style={{ position: "relative", display: "block", width: "100%", height: "100%" }}>
          {props.children}
        </span>
      </button>
    </>
  );
}

/** Выбор приложения для добавления подписки (incy / happ / другое) */
function AppChooser(props: {
  linking: string | null;
  error: string;
  onPick: (app: "incy" | "happ" | "other") => void;
  onClose: () => void;
}) {
  const { linking, error, onPick, onClose } = props;

  const Row = (opts: {
    app: "incy" | "happ" | "other";
    title: string;
    subtitle: string;
    recommended?: boolean;
    img?: string;
    icon?: string;
  }) => {
    const busy = linking === opts.app;
    return (
      <button
        type="button"
        disabled={!!linking}
        onClick={() => onPick(opts.app)}
        style={{
          ...btnReset,
          display: "flex",
          alignItems: "center",
          gap: "14px",
          width: "330px",
          height: "64px",
          padding: "0 16px",
          background: "#3D3D3D",
          borderRadius: "22px",
          border: opts.recommended ? "1px solid rgba(241,135,38,0.6)" : "none",
          cursor: linking ? "wait" : "pointer",
          opacity: linking && !busy ? 0.5 : 1,
        }}
      >
        <span
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: "#484848",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          {opts.img ? (
            <img
              src={opts.img}
              alt=""
              style={{ width: 40, height: 40, objectFit: "cover" }}
              onError={(e) => { e.currentTarget.style.display = "none"; }}
            />
          ) : (
            <MS name={opts.icon || "link"} style={{ fontSize: 22, color: "#E3E3E3" }} />
          )}
        </span>
        <span style={{ flex: 1, textAlign: "left" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 16, color: "#FFFFFF" }}>{opts.title}</span>
            {opts.recommended && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "#F18726",
                  background: "rgba(241,135,38,0.15)",
                  borderRadius: 8,
                  padding: "2px 6px",
                }}
              >
                рекомендуем
              </span>
            )}
          </span>
          <span style={{ display: "block", fontSize: 12, color: "#8A8A8A", marginTop: 2 }}>
            {busy ? "Открываем…" : opts.subtitle}
          </span>
        </span>
        <MS name="chevron_right" style={{ fontSize: 22, color: "#F18726" }} />
      </button>
    );
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "flex-end",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          background: "#212121",
          borderTopLeftRadius: "30px",
          borderTopRightRadius: "30px",
          padding: "18px 26px 28px",
          boxSizing: "border-box",
          borderTop: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontWeight: 600, fontSize: 18, color: "#FFFFFF" }}>Выберите приложение</span>
          <button type="button" onClick={onClose} style={{ ...btnReset, cursor: "pointer" }}>
            <MS name="close" style={{ fontSize: 24, color: "#8A8A8A" }} />
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {Row({ app: "incy", title: "Incy", subtitle: "Быстрое подключение", recommended: true, img: "/assets/incy.png" })}
          {Row({ app: "happ", title: "Happ", subtitle: "Популярное приложение", img: "/assets/happ.png" })}
          {Row({ app: "other", title: "Другое приложение", subtitle: "Получить ссылку на подписку", icon: "link" })}
        </div>
        {error && <div style={{ marginTop: 12, color: "#FF8F8F", fontSize: 13 }}>{error}</div>}
      </div>
    </div>
  );
}

export default function GetStarted() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [device, setDevice] = useState<DeviceKind>("linux");
  const [devices, setDevices] = useState<number>(1);
  const [priceMap, setPriceMap] = useState<Record<number, number>>({
    1: 99,
    2: 169,
    3: 229,
    5: 349,
  });
  const [deviceOptions, setDeviceOptions] = useState<number[]>([1, 2, 3, 5]);
  const [appChooser, setAppChooser] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [linkErr, setLinkErr] = useState("");

  const pickApp = async (which: "incy" | "happ" | "other") => {
    if (linking) return;
    setLinking(which);
    setLinkErr("");
    try {
      const res = await fetchAppLink(which);
      openDeepLink(res);
      setAppChooser(false);
    } catch (e) {
      setLinkErr(e instanceof Error ? e.message : "Не удалось получить ссылку");
    } finally {
      setLinking(null);
    }
  };

  const step = Math.min(5, Math.max(1, parseInt(searchParams.get("step") || "1", 10)));
  const flow = (searchParams.get("flow") || "trial") as "trial" | "purchase";
  const trialUsed = searchParams.get("trialUsed") || "0";

  const needsPaymentStep = flow === "purchase" && trialUsed === "1";

  useEffect(() => {
    setDevice(detectDeviceKind());
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const data = await fetchPlans();
        const opts =
          data.plans.length > 0
            ? data.plans.map((p) => p.devices).sort((a, b) => a - b)
            : [1, 2, 3, 5];
        setDeviceOptions(opts);
        setPriceMap(plansToPriceMap(data.plans));
        setDevices((prev) => (opts.includes(prev) ? prev : opts[0] ?? 1));
      } catch {
        /* keep fallbacks */
      }
    })();
  }, []);

  useEffect(() => {
    if (step === 4 && !needsPaymentStep) {
      setSearchParams(
        { step: "3", flow, trialUsed },
        { replace: true },
      );
    }
  }, [step, needsPaymentStep, flow, trialUsed, setSearchParams]);

  const deviceLabel = useMemo(() => DEVICE_TITLE[device], [device]);

  const installUrl = HAPP_INSTALL_URL[device];

  const setStep = (n: number, extra?: Record<string, string>) => {
    setSearchParams({
      step: String(n),
      flow,
      trialUsed,
      ...extra,
    });
  };

  const goBack = () => {
    if (step <= 1) {
      navigate("/");
      return;
    }
    if (step === 5) {
      setStep(needsPaymentStep ? 4 : 3);
      return;
    }
    if (step === 4) {
      setStep(3);
      return;
    }
    setStep(step - 1);
  };

  const logoFilter = LOGO_GLOW[step];

  const logo = (
    <div
      style={{
        position: "absolute",
        width: "346px",
        height: "346px",
        left: "28px",
        top: "200px",
        pointerEvents: "none",
      }}
    >
      <img
        src="/assets/logo.png"
        width={346}
        height={346}
        alt=""
        draggable={false}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          filter: logoFilter,
          transition: "filter 0.4s ease",
        }}
      />
    </div>
  );

  const backBtn = (
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
      <MS name="chevron_left" style={{ fontSize: 24, color: "#FFFFFF" }} />
    </button>
  );

  const headerTitle = (
    <div
      style={{
        position: "absolute",
        width: "303px",
        height: "33px",
        left: "73px",
        top: "28px",
        display: "flex",
        alignItems: "center",
        fontWeight: 600,
        fontSize: "27px",
        lineHeight: "33px",
        color: "#FFFFFF",
      }}
    >
      Давайте начнём!
    </div>
  );

  /** Иконка справа на серой кнопке «Далее» */
  const nextRowIcon = (
    <span style={{ position: "absolute", left: "181px", top: "13px", color: "#E3E3E3" }}>
      <MS name="chevron_right" style={{ fontSize: 24 }} />
    </span>
  );

  // ─── Step 1 ───────────────────────────────────────────────────────────────
  if (step === 1) {
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
        <div style={pageShell}>
          {backBtn}
          <div
            style={{
              position: "absolute",
              width: "280px",
              height: "33px",
              left: "73px",
              top: "28px",
              display: "flex",
              alignItems: "center",
              fontWeight: 600,
              fontSize: "27px",
              lineHeight: "33px",
              color: "#FFFFFF",
            }}
          >
            Давайте начнём!
          </div>
          <div
            style={{
              position: "absolute",
              left: "26px",
              right: "26px",
              top: "87px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              fontWeight: 500,
              fontSize: "27px",
              lineHeight: "33px",
              color: "#FFFFFF",
            }}
          >
            Настройка на {deviceLabel}
          </div>
          <div
            style={{
              position: "absolute",
              width: "197px",
              height: "36px",
              left: "102px",
              top: "132px",
              display: "flex",
              alignItems: "center",
              textAlign: "center",
              fontWeight: 500,
              fontSize: "15px",
              lineHeight: "18px",
              color: "#FFFFFF",
              opacity: 0.5,
            }}
          >
            Настройка VPN займёт не более 5 минут
          </div>
          {logo}
          <div
            style={{
              position: "absolute",
              width: "350px",
              height: "135px",
              left: "26px",
              top: "628px",
              background: "#333333",
              borderRadius: "30px",
            }}
          />
          <button
            type="button"
            onClick={() => setStep(2)}
            style={{
              ...btnReset,
              position: "absolute",
              width: "330px",
              height: "50px",
              left: "36px",
              top: "642px",
              background: "#F18726",
              borderRadius: "30px",
              border: "none",
              cursor: "pointer",
            }}
          >
            <span style={{ position: "relative", display: "block", width: "100%", height: "100%" }}>
              <span
                style={{
                  position: "absolute",
                  width: "165px",
                  height: "21px",
                  left: "82px",
                  top: "14px",
                  display: "flex",
                  alignItems: "center",
                  fontWeight: 600,
                  fontSize: "17px",
                  lineHeight: "21px",
                  color: "#FFFFFF",
                }}
              >
                Начать настройку!
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setStep(2)}
            style={{
              ...btnReset,
              position: "absolute",
              width: "330px",
              height: "50px",
              left: "36px",
              top: "699px",
              background: "#3D3D3D",
              borderRadius: "30px",
              border: "none",
              cursor: "pointer",
            }}
          >
            <span style={{ position: "relative", display: "block", width: "100%", height: "100%" }}>
              <span
                style={{
                  position: "absolute",
                  width: "285px",
                  height: "21px",
                  left: "22px",
                  top: "14px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 600,
                  fontSize: "17px",
                  lineHeight: "21px",
                  color: "#FFFFFF",
                }}
              >
                Настроить на другом устройстве
              </span>
            </span>
          </button>
        </div>
      </div>
    );
  }

  // ─── Step 2 — установка приложения ────────────────────────────────────────
  if (step === 2) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          minHeight: "100vh",
          background: "#111",
          fontFamily: "'Inter', sans-serif",
        }}
      >
        <div style={pageShell}>
          {backBtn}
          {headerTitle}
          <div
            style={{
              position: "absolute",
              width: "175px",
              height: "33px",
              left: "113px",
              top: "87px",
              display: "flex",
              alignItems: "center",
              fontWeight: 500,
              fontSize: "27px",
              lineHeight: "33px",
              color: "#FFFFFF",
            }}
          >
            Приложение
          </div>
          <div
            style={{
              position: "absolute",
              width: "236px",
              height: "36px",
              left: "83px",
              top: "132px",
              display: "flex",
              alignItems: "center",
              textAlign: "center",
              fontWeight: 500,
              fontSize: "15px",
              lineHeight: "18px",
              color: "#FFFFFF",
              opacity: 0.5,
            }}
          >
            Установите приложение Happ, а затем возвращайтесь
          </div>
          {logo}
          <BottomCardTwoRows
            topOrangeOnClick={() => {
              window.open(installUrl, "_blank", "noopener,noreferrer");
            }}
            topOrange={
              <>
                <span style={{ position: "absolute", left: "45px", top: "13px", color: "#E3E3E3" }}>
                  <MS name="download" style={{ fontSize: 24 }} />
                </span>
                <span
                  style={{
                    position: "absolute",
                    left: "74px",
                    top: "14px",
                    fontWeight: 600,
                    fontSize: "17px",
                    lineHeight: "21px",
                    color: "#FFFFFF",
                  }}
                >
                  Установить приложение
                </span>
              </>
            }
            bottomGrayOnClick={() => setStep(3)}
            bottomGray={
              <>
                <span
                  style={{
                    position: "absolute",
                    left: "125px",
                    top: "14px",
                    fontWeight: 600,
                    fontSize: "17px",
                    lineHeight: "21px",
                    color: "#FFFFFF",
                  }}
                >
                  Далее
                </span>
                {nextRowIcon}
              </>
            }
          />
        </div>
      </div>
    );
  }

  // ─── Step 3 — подписка в Happ ─────────────────────────────────────────────
  if (step === 3) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          minHeight: "100vh",
          background: "#111",
          fontFamily: "'Inter', sans-serif",
        }}
      >
        <div style={pageShell}>
          {backBtn}
          {headerTitle}
          <div
            style={{
              position: "absolute",
              width: "138px",
              height: "33px",
              left: "132px",
              top: "87px",
              display: "flex",
              alignItems: "center",
              fontWeight: 500,
              fontSize: "27px",
              lineHeight: "33px",
              color: "#FFFFFF",
            }}
          >
            Подписка
          </div>
          <div
            style={{
              position: "absolute",
              width: "236px",
              height: "36px",
              left: "83px",
              top: "132px",
              display: "flex",
              alignItems: "center",
              textAlign: "center",
              fontWeight: 500,
              fontSize: "15px",
              lineHeight: "18px",
              color: "#FFFFFF",
              opacity: 0.5,
            }}
          >
            Добавьте подписку в Happ кнопкой ниже
          </div>
          {logo}
          <BottomCardTwoRows
            topOrangeOnClick={() => setAppChooser(true)}
            topOrange={
              <>
                <span style={{ position: "absolute", left: "64px", top: "13px", color: "#E3E3E3" }}>
                  <MS name="add" style={{ fontSize: 24 }} />
                </span>
                <span
                  style={{
                    position: "absolute",
                    left: "93px",
                    top: "14px",
                    fontWeight: 600,
                    fontSize: "17px",
                    lineHeight: "21px",
                    color: "#FFFFFF",
                  }}
                >
                  Добавить подписку
                </span>
              </>
            }
            bottomGrayOnClick={() => {
              if (needsPaymentStep) setStep(4);
              else setStep(5);
            }}
            bottomGray={
              <>
                <span
                  style={{
                    position: "absolute",
                    left: "125px",
                    top: "14px",
                    fontWeight: 600,
                    fontSize: "17px",
                    lineHeight: "21px",
                    color: "#FFFFFF",
                  }}
                >
                  Далее
                </span>
                {nextRowIcon}
              </>
            }
          />
          {appChooser && (
            <AppChooser
              linking={linking}
              error={linkErr}
              onPick={pickApp}
              onClose={() => { setAppChooser(false); setLinkErr(""); }}
            />
          )}
        </div>
      </div>
    );
  }

  // ─── Step 4 — оплата (только purchase + уже был триал) ───────────────────
  const step4Price = priceMap[devices] ?? 99;
  const step4PillStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    height: "44px",
    background: active ? "#F18726" : "#3D3D3D",
    borderRadius: "22px",
    border: "none",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "1px",
    transition: "background 0.15s ease",
  });

  if (step === 4) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          minHeight: "100vh",
          background: "#111",
          fontFamily: "'Inter', sans-serif",
        }}
      >
        <div style={pageShell}>
          {backBtn}
          {headerTitle}
          <div
            style={{
              position: "absolute",
              left: "73px",
              top: "87px",
              fontWeight: 500,
              fontSize: "27px",
              lineHeight: "33px",
              color: "#FFFFFF",
            }}
          >
            Оплата
          </div>
          <div
            style={{
              position: "absolute",
              width: "293px",
              left: "54px",
              top: "132px",
              textAlign: "center",
              fontWeight: 500,
              fontSize: "15px",
              lineHeight: "18px",
              color: "#FFFFFF",
              opacity: 0.5,
            }}
          >
            Вы уже использовали пробный период, оплатите для использования
          </div>
          {logo}

          {/* Карточка с пилюлями и суммой */}
          <div
            style={{
              position: "absolute",
              left: "26px",
              top: "570px",
              width: "350px",
              background: "#333333",
              borderRadius: "30px",
              padding: "18px 20px 20px",
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              gap: "14px",
            }}
          >
            <div
              style={{
                fontSize: "13px",
                fontWeight: 500,
                color: "#FFFFFF",
                opacity: 0.53,
              }}
            >
              Устройств в подписке:
            </div>
            <div style={{ display: "flex", gap: "6px" }}>
              {deviceOptions.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setDevices(n)}
                  style={step4PillStyle(devices === n)}
                >
                  <span style={{ fontSize: "17px", fontWeight: 700, lineHeight: 1, color: "#FFFFFF" }}>
                    {n}
                  </span>
                  <span
                    style={{
                      fontSize: "10px",
                      fontWeight: 500,
                      color: "#FFFFFF",
                      opacity: devices === n ? 0.85 : 0.45,
                      lineHeight: 1,
                    }}
                  >
                    {priceMap[n] ?? "—"} ₽
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Кнопка оплаты */}
          <button
            type="button"
            onClick={() => navigate(`/payment?devices=${devices}`)}
            style={{
              position: "absolute",
              width: "330px",
              height: "50px",
              left: "36px",
              top: "717px",
              background: "#F18726",
              borderRadius: "30px",
              border: "none",
              padding: 0,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
            }}
          >
            <span style={{ fontSize: "17px", fontWeight: 600, color: "#FFFFFF" }}>
              Оплатить {step4Price} ₽
            </span>
            <MS name="chevron_right" style={{ fontSize: 22, color: "#E3E3E3" }} />
          </button>
        </div>
      </div>
    );
  }

  // ─── Step 5 — готово ─────────────────────────────────────────────────────
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "100vh",
        background: "#111",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <div style={pageShell}>
        {backBtn}
        {headerTitle}
        <div
          style={{
            position: "absolute",
            width: "104px",
            height: "33px",
            left: "149px",
            top: "87px",
            display: "flex",
            alignItems: "center",
            fontWeight: 500,
            fontSize: "27px",
            lineHeight: "33px",
            color: "#FFFFFF",
          }}
        >
          Готово!
        </div>
        <div
          style={{
            position: "absolute",
            width: "293px",
            height: "36px",
            left: "54px",
            top: "132px",
            display: "flex",
            alignItems: "center",
            textAlign: "center",
            fontWeight: 500,
            fontSize: "15px",
            lineHeight: "18px",
            color: "#FFFFFF",
            opacity: 0.5,
          }}
        >
          Вы успешно подключили и запустили VPN. Приятного пользования!
        </div>
        {logo}
        <BottomCardOneRow onClick={() => navigate("/")}>
          <span
            style={{
              position: "absolute",
              width: "189px",
              height: "21px",
              left: "70px",
              top: "14px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 600,
              fontSize: "17px",
              lineHeight: "21px",
              color: "#FFFFFF",
            }}
          >
            Завершить настройку
          </span>
        </BottomCardOneRow>
      </div>
    </div>
  );
}