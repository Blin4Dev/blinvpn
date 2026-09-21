import React, { useState } from "react";
import { MSIcon } from "../components/ui";
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
        minHeight: "100vh",
        background: "#212121",
        fontFamily: "'Inter', sans-serif",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 402,
          minHeight: "100vh",
          padding: "20px 20px 32px",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Шапка */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 8 }}>
          <button
            type="button"
            onClick={goBack}
            aria-label="Назад"
            style={{
              flex: "0 0 auto", width: 40, height: 40, borderRadius: "50%",
              background: "#313131", border: "none", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <MSIcon name="chevron_left" style={{ color: "#FFFFFF", fontSize: 24 }} />
          </button>
          <div style={{ fontWeight: 700, fontSize: 26, color: "#FFFFFF" }}>Промокод</div>
        </div>

        {/* Иконка + заголовок */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 12, marginTop: 24, marginBottom: 28 }}>
          <div
            style={{
              width: 88, height: 88, borderRadius: "50%", background: "rgba(241,135,38,0.16)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <MSIcon name="redeem" style={{ color: "#F18726", fontSize: 44 }} />
          </div>
          <div style={{ fontWeight: 700, fontSize: 22, color: "#FFFFFF" }}>Активируйте промокод</div>
          <div style={{ fontSize: 14, color: "#7D7D7D", maxWidth: 260, lineHeight: "20px" }}>
            Введите код и получите бонус — скидку на подписку.
          </div>
        </div>

        {/* Поле ввода */}
        <input
          value={promo}
          placeholder="Введите код"
          onChange={(e) => setPromo(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === "Enter") void activate(); }}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          style={{
            width: "100%",
            boxSizing: "border-box",
            height: 58,
            background: "#2E2E2E",
            border: "1px solid #3D3D3D",
            borderRadius: 16,
            padding: "0 18px",
            color: "#FFFFFF",
            fontWeight: 600,
            fontSize: 18,
            letterSpacing: "1px",
            textAlign: "center",
            textTransform: "uppercase",
            outline: "none",
          }}
        />

        {info && (
          <div style={{ marginTop: 14, textAlign: "center", fontSize: 14, color: ok ? "#8CE99A" : "#FF9D9D" }}>
            {info}
          </div>
        )}

        <button
          type="button"
          disabled={busy}
          onClick={() => void activate()}
          style={{
            width: "100%",
            marginTop: 20,
            height: 54,
            background: "#F18726",
            borderRadius: 18,
            border: "none",
            color: "#FFFFFF",
            fontWeight: 700,
            fontSize: 17,
            cursor: busy ? "wait" : "pointer",
            opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? "…" : "Активировать"}
        </button>
      </div>
    </div>
  );
}
