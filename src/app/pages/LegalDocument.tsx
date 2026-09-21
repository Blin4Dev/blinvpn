import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { BackCircleButton } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { fetchLegal } from "../utils/api";

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
            right: "26px",
            fontWeight: 600,
            fontSize: "22px",
            lineHeight: "28px",
            color: "#FFFFFF",
          }}
        >
          {title}
        </div>
        <div
          style={{
            position: "absolute",
            left: "26px",
            right: "26px",
            top: "90px",
            bottom: "26px",
            overflowY: "auto",
            padding: "16px 18px",
            background: "#333333",
            borderRadius: "20px",
            color: "#E3E3E3",
            fontSize: "14px",
            lineHeight: "1.55",
            whiteSpace: "pre-wrap",
          }}
        >
          {loading ? "Загрузка…" : text || "Документ пуст."}
        </div>
      </div>
    </div>
  );
}
