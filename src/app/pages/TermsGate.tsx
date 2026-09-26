import React, { useState } from "react";
import { acceptTerms, fetchLegal } from "../utils/api";
import { Btn, MSIcon, T, btnReset } from "../components/ui";

type Doc = "offer" | "privacy";
const DOC_TITLE: Record<Doc, string> = { offer: "Договор оферты", privacy: "Политика конфиденциальности" };

/**
 * Обязательное согласие с офертой и политикой конфиденциальности при первом входе
 * (и в мини-приложении, и на сайте). Закрыть нельзя — только прочитать и принять.
 */
export default function TermsGate({ onAccepted }: { onAccepted: () => void }) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [doc, setDoc] = useState<Doc | null>(null);
  const [docs, setDocs] = useState<Record<Doc, string> | null>(null);

  const openDoc = async (d: Doc) => {
    setDoc(d);
    if (!docs) {
      try {
        const l = await fetchLegal();
        setDocs({ offer: l.offer || "Документ пока не опубликован.", privacy: l.privacy || "Документ пока не опубликован." });
      } catch {
        setDocs({ offer: "Не удалось загрузить документ. Попробуйте позже.", privacy: "Не удалось загрузить документ. Попробуйте позже." });
      }
    }
  };

  const accept = async () => {
    if (!checked || busy) return;
    setBusy(true);
    setErr("");
    try {
      await acceptTerms();
      onAccepted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось сохранить. Попробуйте ещё раз.");
    } finally {
      setBusy(false);
    }
  };

  const link: React.CSSProperties = { ...btnReset, background: "transparent", border: "none", padding: 0, textDecoration: "underline", textUnderlineOffset: 3, color: T.orange, fontWeight: 600, fontSize: "inherit", cursor: "pointer", display: "inline" };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed", inset: 0, zIndex: 3100, background: "rgba(8, 6, 4, 0.78)",
        backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", display: "flex",
        alignItems: "center", justifyContent: "center", padding: 20, boxSizing: "border-box",
        fontFamily: T.font, animation: "blinvpnFadeIn 0.2s ease both",
      }}
    >
      <div
        style={{
          width: "100%", maxWidth: 380, maxHeight: "88vh", background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: T.radius.xl, padding: doc ? "18px 18px 16px" : "28px 22px 18px", boxSizing: "border-box",
          display: "flex", flexDirection: "column", animation: "blinvpnSheetUp 0.28s var(--ease-out) both",
        }}
      >
        {doc ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <button type="button" aria-label="Назад" onClick={() => setDoc(null)} className="blin-press"
                style={{ ...btnReset, width: 36, height: 36, borderRadius: 12, background: T.surfaceRaised, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                <MSIcon name="arrow_back" style={{ fontSize: 20, color: T.text }} />
              </button>
              <div style={{ fontWeight: 600, fontSize: 17, color: T.text }}>{DOC_TITLE[doc]}</div>
            </div>
            <div style={{ overflowY: "auto", whiteSpace: "pre-wrap", fontSize: 14, lineHeight: "21px", color: T.textMuted, paddingRight: 4, flex: 1 }}>
              {docs ? docs[doc] : "Загрузка…"}
            </div>
            <Btn variant="secondary" onClick={() => setDoc(null)} style={{ marginTop: 14 }}>Понятно</Btn>
          </>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
            <div style={{ width: 56, height: 56, borderRadius: 18, background: T.orangeSoft, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
              <MSIcon name="description" style={{ color: T.orange, fontSize: 30 }} />
            </div>
            <div style={{ fontWeight: 600, fontSize: 20, color: T.text, letterSpacing: "-0.02em" }}>Добро пожаловать!</div>
            <div style={{ fontSize: 14, lineHeight: 1.5, color: T.textMuted, marginTop: 8, marginBottom: 18 }}>
              Перед началом ознакомьтесь с условиями использования BlinVPN.
            </div>

            <label style={{ display: "flex", gap: 12, alignItems: "flex-start", textAlign: "left", cursor: "pointer", width: "100%", background: T.surfaceRaised, borderRadius: 14, padding: "12px 14px", boxSizing: "border-box" }}>
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)}
                style={{ width: 20, height: 20, marginTop: 1, accentColor: T.orange, flex: "none" }} />
              <span style={{ fontSize: 14, lineHeight: 1.45, color: T.text }}>
                Я прочитал(а) и принимаю{" "}
                <button type="button" style={link} onClick={(e) => { e.preventDefault(); void openDoc("offer"); }}>договор оферты</button>
                {" "}и{" "}
                <button type="button" style={link} onClick={(e) => { e.preventDefault(); void openDoc("privacy"); }}>политику конфиденциальности</button>
              </span>
            </label>

            <Btn disabled={!checked || busy} onClick={() => void accept()} style={{ marginTop: 16 }}>
              {busy ? "Сохраняем…" : "Продолжить"}
            </Btn>
            {err ? <div style={{ fontSize: 13, color: T.danger, marginTop: 8 }}>{err}</div> : null}
          </div>
        )}
      </div>
    </div>
  );
}
