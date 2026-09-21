import React, { useState } from "react";
import { BackCircleButton, MSIcon } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { appFetch } from "../utils/api";

export default function Promocode() {
  const goBack = useSmartBack("/");
  const [promo, setPromo] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState("");
  const [ok, setOk] = useState(false);

  const activate = async () => {
    const code = promo.trim().toUpperCase();
    if (!code) {
      setOk(false);
      setInfo("Введите промокод.");
      return;
    }
    setBusy(true);
    setInfo("");
    try {
      const res = await appFetch<{ success?: boolean; type?: string; value?: number; discount_percent?: number }>(
        "/promocode/redeem",
        { method: "POST", body: JSON.stringify({ code }) },
      );
      setOk(true);
      const percent = res.discount_percent ?? res.value ?? 0;
      setInfo(`Скидка ${percent}% активирована на 90 дней`);
      setPromo("");
    } catch (e) {
      setOk(false);
      setInfo(e instanceof Error ? e.message : "Не удалось активировать");
    } finally {
      setBusy(false);
    }
  };

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
            width: "280px",
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
          Промокод
        </div>

        <div
          style={{
            position: "absolute",
            width: "96px",
            height: "96px",
            left: "153px",
            top: "109px",
            background: "rgba(241, 135, 38, 0.3)",
            borderRadius: "50px",
          }}
        />

        <MSIcon
          name="redeem"
          style={{
            position: "absolute",
            width: "48px",
            height: "48px",
            left: "177px",
            top: "133px",
            color: "#F18726",
            fontSize: 48,
          }}
        />

        <div
          style={{
            position: "absolute",
            width: "149px",
            height: "33px",
            left: "126px",
            top: "211px",
            fontWeight: 600,
            fontSize: "27px",
            lineHeight: "33px",
            display: "flex",
            alignItems: "center",
            color: "#FFFFFF",
          }}
        >
          Промокод
        </div>

        <div
          style={{
            position: "absolute",
            width: "276px",
            height: "36px",
            left: "63px",
            top: "254px",
            fontWeight: 500,
            fontSize: "15px",
            lineHeight: "18px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            color: "#FFFFFF",
            opacity: 0.5,
          }}
        >
          Активируйте промокод и получите бонус
        </div>

        <div
          style={{
            position: "absolute",
            width: "330px",
            height: "56px",
            left: "36px",
            top: "310px",
            boxSizing: "border-box",
            background: "#313131",
            border: "1px solid #3D3D3D",
            borderRadius: "7px",
          }}
        >
          <input
            value={promo}
            placeholder="Введите код"
            onChange={(e) => setPromo(e.target.value.toUpperCase())}
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              outline: "none",
              background: "transparent",
              fontWeight: 500,
              fontSize: "24px",
              lineHeight: "29px",
              textAlign: "center",
              color: "#FFFFFF",
              opacity: 0.5,
              textTransform: "uppercase",
            }}
          />
        </div>

        {info && (
          <div
            style={{
              position: "absolute",
              left: "36px",
              right: "36px",
              top: "380px",
              textAlign: "center",
              fontSize: 14,
              color: ok ? "#8CE99A" : "#FF9D9D",
            }}
          >
            {info}
          </div>
        )}

        <button
          type="button"
          disabled={busy}
          onClick={() => void activate()}
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
            cursor: busy ? "wait" : "pointer",
            opacity: busy ? 0.7 : 1,
          }}
        >
          <span
            style={{
              position: "absolute",
              width: "128px",
              height: "21px",
              left: "101px",
              top: "14px",
              fontWeight: 600,
              fontSize: "17px",
              lineHeight: "21px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#FFFFFF",
            }}
          >
            {busy ? "…" : "Активировать"}
          </span>
        </button>
      </div>
    </div>
  );
}
