import React, { useState } from "react";
import { Btn, Field, PageHeader, Screen, T } from "../components/ui";
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

      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 14, color: T.textMuted, lineHeight: 1.5 }}>
          Введите код — скидка применится к следующей оплате подписки.
        </div>
      </div>

      <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 8 }}>Код</div>
      <Field
        value={promo}
        placeholder="PROMO2026"
        onChange={(v) => setPromo(v.toUpperCase())}
        onKeyDown={(e) => { if (e.key === "Enter") void activate(); }}
        style={{
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      />

      {info ? (
        <div
          style={{
            marginTop: 12,
            fontSize: 13,
            color: ok ? T.success : T.danger,
            lineHeight: 1.4,
          }}
        >
          {info}
        </div>
      ) : null}

      <Btn disabled={busy || !promo.trim()} onClick={() => void activate()} style={{ marginTop: 20 }}>
        {busy ? "Проверяем…" : "Активировать"}
      </Btn>
    </Screen>
  );
}
