import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BackCircleButton, MSIcon } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { fetchPlans, plansToPriceMap } from "../utils/api";

const FALLBACK_OPTIONS = [1, 2, 3, 5];
const FALLBACK_PRICES: Record<number, number> = {
  1: 99,
  2: 169,
  3: 229,
  5: 349,
};

export default function ExtendSubscription() {
  const navigate = useNavigate();
  const goBack = useSmartBack("/subscription");
  const [deviceOptions, setDeviceOptions] = useState<number[]>(FALLBACK_OPTIONS);
  const [priceMap, setPriceMap] = useState<Record<number, number>>(FALLBACK_PRICES);
  const [devices, setDevices] = useState<number>(1);

  useEffect(() => {
    void (async () => {
      try {
        const data = await fetchPlans();
        const opts =
          data.plans.length > 0
            ? data.plans.map((p) => p.devices).sort((a, b) => a - b)
            : FALLBACK_OPTIONS;
        setDeviceOptions(opts);
        setPriceMap(plansToPriceMap(data.plans));
        setDevices((prev) => (opts.includes(prev) ? prev : opts[0] ?? 1));
      } catch {
        /* keep fallbacks */
      }
    })();
  }, []);

  const pillStyle = (active: boolean): React.CSSProperties => ({
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

  const price = priceMap[devices] ?? 99;
  const deviceLabel =
    devices === 1 ? "устройство" : devices < 5 ? "устройства" : "устройств";

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
      <div
        style={{
          position: "relative",
          width: "402px",
          height: "803px",
          background: "#212121",
          overflow: "hidden",
        }}
      >
        <BackCircleButton onClick={goBack} />

        <div
          style={{
            position: "absolute",
            left: "73px",
            top: "28px",
            fontWeight: 600,
            fontSize: "27px",
            lineHeight: "33px",
            color: "#FFFFFF",
          }}
        >
          Продлить подписку
        </div>

        {/* Карточка: остаток времени */}
        <div
          style={{
            position: "absolute",
            width: "350px",
            left: "26px",
            top: "87px",
            background: "#333333",
            borderRadius: "30px",
            padding: "16px 27px 18px",
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              fontSize: "13px",
              fontWeight: 500,
              color: "#FFFFFF",
              opacity: 0.53,
              marginBottom: "4px",
              letterSpacing: "0.04em",
            }}
          >
            ОСТАЛОСЬ
          </div>
          <div
            style={{
              fontSize: "32px",
              fontWeight: 700,
              lineHeight: "39px",
              color: "#F18726",
            }}
          >
            —
          </div>
          <div
            style={{
              fontSize: "13px",
              fontWeight: 500,
              color: "#FFFFFF",
              opacity: 0.53,
              marginTop: "4px",
            }}
          >
            Выберите тариф для продления
          </div>
        </div>

        {/* Карточка: выбор устройств + итог */}
        <div
          style={{
            position: "absolute",
            width: "350px",
            left: "26px",
            top: "232px",
            background: "#333333",
            borderRadius: "30px",
            padding: "22px 27px 24px",
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
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
            Продление · 1 месяц
          </div>

          <div>
            <div
              style={{
                fontSize: "13px",
                fontWeight: 500,
                color: "#FFFFFF",
                opacity: 0.53,
                marginBottom: "8px",
              }}
            >
              Количество устройств:
            </div>
            <div style={{ display: "flex", gap: "6px" }}>
              {deviceOptions.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setDevices(n)}
                  style={pillStyle(devices === n)}
                >
                  <span
                    style={{
                      fontSize: "17px",
                      fontWeight: 700,
                      lineHeight: 1,
                      color: "#FFFFFF",
                    }}
                  >
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

          <div
            style={{
              height: "1px",
              background: "rgba(255,255,255,0.08)",
            }}
          />

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ fontSize: "15px", fontWeight: 500, color: "#FFFFFF", opacity: 0.6 }}>
              {devices} {deviceLabel} · 1 месяц
            </div>
            <div
              style={{
                fontSize: "24px",
                fontWeight: 700,
                color: "#F18726",
                transition: "opacity 0.15s ease",
              }}
            >
              {price} ₽
            </div>
          </div>
        </div>

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
          <span
            style={{
              fontSize: "17px",
              fontWeight: 600,
              color: "#FFFFFF",
            }}
          >
            Продлить за {price} ₽
          </span>
          <MSIcon name="chevron_right" style={{ fontSize: 22, color: "#E3E3E3" }} />
        </button>
      </div>
    </div>
  );
}
