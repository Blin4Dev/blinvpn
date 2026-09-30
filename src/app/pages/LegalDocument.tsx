import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { PageHeader, Screen, T } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { fetchLegal } from "../utils/api";
import { RichText } from "../components/RichText";

export default function LegalDocument() {
  const { kind } = useParams<{ kind: string }>();
  const goBack = useSmartBack("/settings");
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const title = kind === "privacy" ? "Политика конфиденциальности" : "Договор оферты";

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const legal = await fetchLegal();
        setText(kind === "privacy" ? legal.privacy : legal.offer);
      } catch {
        setText("Не удалось загрузить документ. Попробуйте позже.");
      } finally {
        setLoading(false);
      }
    })();
  }, [kind]);

  return (
    <Screen>
      <PageHeader title={title} onBack={goBack} />
      <div style={{ paddingBottom: 24 }}>
        {loading ? <div style={{ fontSize: 14, color: T.textMuted }}>Загрузка…</div> : <RichText text={text} />}
      </div>
    </Screen>
  );
}
