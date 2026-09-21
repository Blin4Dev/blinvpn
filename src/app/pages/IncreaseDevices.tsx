import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BackCircleButton, MSIcon } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { fetchPlans, fetchSubscription } from "../utils/api";

export default function IncreaseDevices() {
  const navigate = useNavigate();
  const goBack = useSmartBack("/subscription");

  const maxDevices = 15;
  // База = ТЕКУЩИЙ лимит устройств активной подписки (докупаем сверх него).
  const [baseIncluded, setBaseIncluded] = useState(1);
  const [pricePerDeviceRub, setPricePerDeviceRub] = useState(40);
  const [targetMax, setTargetMax] = useState<number>(1);
  const [subId, setSubId] = useState<number | null>(null);
  const [daysLeft, setDaysLeft] = useState<number>(30);

  useEffect(() => {
    void (async () => {
      try {
        const data = await fetchPlans();
        setPricePerDeviceRub(data.extra_device_price || 40);
      } catch {
        /* keep defaults */
      }
      try {
        const sub = await fetchSubscription();
        const k = sub?.key;
        const limit = Math.max(1, Number(k?.devices_limit ?? 1));
        setBaseIncluded(limit);
        setTargetMax((prev) => Math.max(limit, prev, limit + 1 > maxDevices ? limit : limit + 1));
        if (k?.id) setSubId(Number(k.id));
        // остаток дней — для пропорциональной цены докупки
        let dl = Number(k?.days_left ?? NaN);
        if (!Number.isFinite(dl) && k?.expiry_date) {
          dl = Math.max(0, Math.ceil((new Date(k.expiry_date).getTime() - Date.now()) / 86400000));
        }
        if (Number.isFinite(dl)) setDaysLeft(Math.max(0, dl));
      } catch {
        /* keep defaults */
      }
    })();
  }, []);

  const extra = Math.max(0, targetMax - baseIncluded);
  // Цена докупки пропорциональна остатку дней (как на сервере): цена × дней/30 × кол-во.
  const totalRub = Math.round(extra * pricePerDeviceRub * (Math.min(daysLeft, 3650) / 30));

  const title = useMemo(() => {
    if (extra === 0) return "Докупка устройств";
    if (extra === 1) return "1 устройство";
    if (extra >= 2 && extra <= 4) return `${extra} устройства`;
    return `${extra} устройств`;
  }, [extra]);

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "100vh",
        background: "#0C0A08",
        fontFamily: "'Outfit', system-ui, sans-serif",
      }}
    >
      <div
        style={{
          position: "relative",
          width: "402px",
          height: "803px",
          background: "#14110E",
          overflow: "hidden",
          boxSizing: "border-box",
        }}
      >
        {/* Назад */}
        <BackCircleButton onClick={goBack} />

        <div
          style={{
            position: "absolute",
            width: "260px",
            height: "33px",
            left: "73px",
            top: "28px",
            fontWeight: 600,
            fontSize: "27px",
            lineHeight: "33px",
            display: "flex",
            alignItems: "center",
            color: "#FFFFFF",
          }}
        >
          Устройства
        </div>

        {/* Карточка */}
        <div
          style={{
            position: "absolute",
            width: "350px",
            height: "330px",
            left: "26px",
            top: "87px",
            background: "#2A241E",
            borderRadius: "30px",
          }}
        />

        <div
          style={{
            position: "absolute",
            width: "310px",
            left: "46px",
            top: "111px",
            fontWeight: 600,
            fontSize: "20px",
            lineHeight: "24px",
            color: "#FFFFFF",
            display: "flex",
            alignItems: "center",
          }}
        >
          {title}
        </div>

        <div
          style={{
            position: "absolute",
            width: "310px",
            left: "46px",
            top: "145px",
            fontWeight: 500,
            fontSize: "13px",
            lineHeight: "16px",
            color: "#FFFFFF",
            opacity: 0.53,
            display: "flex",
            alignItems: "center",
          }}
        >
          Сейчас в подписке {baseIncluded} устр. Докупка слота — {pricePerDeviceRub} ₽/мес, но платите только за
          остаток срока (осталось ~{daysLeft} дн.). Лимит увеличится сразу, срок подписки не меняется.
        </div>

        {/* Счетчик */}
        <div
          style={{
            position: "absolute",
            width: "330px",
            height: "68px",
            left: "36px",
            top: "206px",
            background: "#352E26",
            borderRadius: "30px",
          }}
        />

        <button
          type="button"
          onClick={() => setTargetMax((v) => Math.max(baseIncluded, v - 1))}
          style={{
            position: "absolute",
            width: "48px",
            height: "48px",
            left: "52px",
            top: "216px",
            background: "#352E26",
            borderRadius: "12px",
            border: "none",
            padding: 0,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          aria-label="Уменьшить"
        >
          <MSIcon name="remove" style={{ color: "#E3E3E3", opacity: 0.85 }} />
        </button>

        <button
          type="button"
          onClick={() => setTargetMax((v) => Math.min(maxDevices, v + 1))}
          style={{
            position: "absolute",
            width: "48px",
            height: "48px",
            left: "302px",
            top: "216px",
            background: "#352E26",
            borderRadius: "12px",
            border: "none",
            padding: 0,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          aria-label="Увеличить"
        >
          <MSIcon name="add" style={{ color: "#E3E3E3", opacity: 0.85 }} />
        </button>

        <div
          style={{
            position: "absolute",
            left: "120px",
            top: "226px",
            width: "162px",
            height: "21px",
            fontWeight: 600,
            fontSize: "17px",
            lineHeight: "21px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#FFFFFF",
          }}
        >
          {targetMax} устройств
        </div>

        <div
          style={{
            position: "absolute",
            left: "120px",
            top: "248px",
            width: "162px",
            height: "16px",
            fontWeight: 500,
            fontSize: "13px",
            lineHeight: "16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#A89B8C",
          }}
        >
          +{extra} / {maxDevices - baseIncluded} доп.
        </div>

        {/* Цена */}
        <div
          style={{
            position: "absolute",
            width: "330px",
            height: "68px",
            left: "36px",
            top: "286px",
            background: "#352E26",
            borderRadius: "30px",
          }}
        />

        <div
          style={{
            position: "absolute",
            left: "53px",
            top: "300px",
            fontWeight: 500,
            fontSize: "13px",
            lineHeight: "16px",
            color: "#A89B8C",
            display: "flex",
            alignItems: "center",
          }}
        >
          Итого:
        </div>
        <div
          style={{
            position: "absolute",
            left: "53px",
            top: "318px",
            fontWeight: 700,
            fontSize: "32px",
            lineHeight: "39px",
            color: "#FF6B1A",
            display: "flex",
            alignItems: "center",
          }}
        >
          {totalRub} ₽
        </div>

        {/* Оплата */}
        <button
          type="button"
          disabled={extra === 0}
          onClick={() => navigate(`/payment?type=devices&count=${extra}&amount=${totalRub}${subId ? `&sub=${subId}` : ""}`)}
          style={{
            position: "absolute",
            width: "330px",
            height: "50px",
            left: "36px",
            top: "717px",
            background: "#FF6B1A",
            borderRadius: "30px",
            border: "none",
            padding: 0,
            cursor: extra === 0 ? "not-allowed" : "pointer",
            opacity: extra === 0 ? 0.45 : 1,
          }}
        >
          <span
            style={{
              position: "absolute",
              left: "126px",
              top: "14px",
              width: "150px",
              height: "21px",
              fontWeight: 600,
              fontSize: "17px",
              lineHeight: "21px",
              display: "flex",
              alignItems: "center",
              color: "#FFFFFF",
            }}
          >
            Перейти к оплате
          </span>
          <MSIcon
            name="chevron_right"
            style={{
              position: "absolute",
              left: "250px",
              top: "13px",
              color: "#E3E3E3",
            }}
          />
        </button>
      </div>
    </div>
  );
}
