import React, { useState } from "react";
import { Btn, Field, MSIcon, PageHeader, Screen, T } from "../components/ui";
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
    <Screen>
      <PageHeader title="Промокод" onBack={goBack} />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          gap: 12,
          marginTop: 28,
          marginBottom: 28,
        }}
      >
        <div
          style={{
            width: 88,
            height: 88,
            borderRadius: 28,
            background: T.orangeSoft,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <MSIcon name="redeem" style={{ color: T.orange, fontSize: 44 }} />
        </div>
        <div style={{ fontWeight: 700, fontSize: 22, color: T.text, letterSpacing: "-0.02em" }}>
          Активируйте промокод
        </div>
        <div style={{ fontSize: 14, color: T.textMuted, maxWidth: 260, lineHeight: "20px" }}>
          Введите код и получите скидку на подписку.
        </div>
      </div>

      <Field
        value={promo}
        placeholder="Введите код"
        onChange={(v) => setPromo(v.toUpperCase())}
        onKeyDown={(e) => { if (e.key === "Enter") void activate(); }}
        style={{
          height: 58,
          fontWeight: 600,
          fontSize: 18,
          letterSpacing: "1px",
          textAlign: "center",
          textTransform: "uppercase",
        }}
      />

      {info && (
        <div
          style={{
            marginTop: 14,
            textAlign: "center",
            fontSize: 14,
            color: ok ? T.success : T.danger,
          }}
        >
          {info}
        </div>
      )}

      <Btn disabled={busy} onClick={() => void activate()} style={{ marginTop: 20 }}>
        {busy ? "…" : "Активировать"}
      </Btn>
    </Screen>
  );
}
