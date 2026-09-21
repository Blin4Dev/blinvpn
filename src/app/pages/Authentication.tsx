import React, { useCallback, useEffect, useMemo, useState } from "react";
import { LoadingScreen } from "../components/ui";
import {
  appFetch,
  requestEmailCode,
  setAppToken,
  verifyEmailCode,
  type AppUser,
} from "../utils/api";

type Step = "email" | "code";

export default function Authentication({ onAuthed }: { onAuthed: () => void }) {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const [oauthBotId, setOauthBotId] = useState("");
  const [explicitOauthUrl, setExplicitOauthUrl] = useState("");
  const [oauthBusy, setOauthBusy] = useState(false);

  const oauthReturnTo = `${window.location.origin}/`;
  const oauthUrl = explicitOauthUrl || (oauthBotId
    ? `https://oauth.telegram.org/auth?bot_id=${encodeURIComponent(oauthBotId)}&origin=${encodeURIComponent(window.location.origin)}&return_to=${encodeURIComponent(oauthReturnTo)}&request_access=write`
    : "");

  const validEmail = useMemo(() => /\S+@\S+\.\S+/.test(email.trim()), [email]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/app/config");
        const body = (await res.json().catch(() => null)) as
          | { telegramOauthBotId?: string; telegramOauthUrl?: string }
          | null;
        if (!res.ok || !body) return;
        if (typeof body.telegramOauthBotId === "string") setOauthBotId(body.telegramOauthBotId.trim());
        if (typeof body.telegramOauthUrl === "string") setExplicitOauthUrl(body.telegramOauthUrl.trim());
      } catch {
        /* ignore */
      }
    })();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.get("hash") || !params.get("id")) return;
    const FIELDS = ["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"] as const;
    const payload = Object.fromEntries(
      FIELDS.flatMap((k) => {
        const v = params.get(k);
        return v !== null ? [[k, v]] : [];
      }),
    );
    setOauthBusy(true);
    void (async () => {
      try {
        const b = await appFetch<{ user?: AppUser; token?: string }>("/auth/oauth", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (b.token) setAppToken(b.token);
        window.history.replaceState({}, "", window.location.pathname);
        onAuthed();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Не удалось войти через Telegram");
        setOauthBusy(false);
      }
    })();
  }, [onAuthed]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const sendCode = useCallback(async () => {
    if (busy || !validEmail) return;
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const r = await requestEmailCode(email.trim());
      setStep("code");
      setResendIn(r.resend_after || 60);
      setInfo(
        r.dev_code
          ? `Код (демо-режим): ${r.dev_code}`
          : "Мы отправили код на вашу почту. Проверьте входящие.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отправить код");
    } finally {
      setBusy(false);
    }
  }, [busy, email, validEmail]);

  const confirmCode = useCallback(async () => {
    if (busy || code.trim().length < 4) return;
    setBusy(true);
    setError("");
    try {
      await verifyEmailCode(email.trim(), code.trim());
      onAuthed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Неверный код");
    } finally {
      setBusy(false);
    }
  }, [busy, code, email, onAuthed]);

  if (oauthBusy) return <LoadingScreen text="Входим через Telegram…" />;

  const frame: React.CSSProperties = {
    position: "relative",
    width: "402px",
    minHeight: "803px",
    background: "#212121",
    boxSizing: "border-box",
    padding: "72px 26px 40px",
    color: "#fff",
  };
  const label: React.CSSProperties = { fontSize: 13, fontWeight: 500, color: "#8A8A8A", marginBottom: 8, marginLeft: 4 };
  const input: React.CSSProperties = {
    width: "100%",
    height: 54,
    borderRadius: 16,
    border: "1px solid #444",
    background: "#2B2B2B",
    color: "#fff",
    padding: "0 16px",
    fontSize: 16,
    outline: "none",
    boxSizing: "border-box",
  };
  const primaryBtn = (enabled: boolean): React.CSSProperties => ({
    width: "100%",
    height: 54,
    marginTop: 18,
    borderRadius: 30,
    border: "none",
    background: enabled ? "#F18726" : "#5a4023",
    color: "#fff",
    fontSize: 17,
    fontWeight: 600,
    cursor: enabled ? "pointer" : "not-allowed",
    opacity: enabled ? 1 : 0.7,
  });
  const linkBtn: React.CSSProperties = {
    background: "transparent",
    border: "none",
    color: "#F18726",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
    marginTop: 16,
  };

  return (
    <div style={{ display: "flex", justifyContent: "center", minHeight: "100vh", background: "#111", fontFamily: "'Inter', sans-serif" }}>
      <div style={frame}>
        <div style={{ fontWeight: 700, fontSize: 30, color: "#fff" }}>
          Blin<span style={{ color: "#FF6E00" }}>VPN</span>
        </div>
        <div style={{ fontWeight: 600, fontSize: 24, marginTop: 26 }}>
          {step === "email" ? "Вход" : "Введите код"}
        </div>
        <div style={{ marginTop: 8, opacity: 0.6, fontSize: 14, lineHeight: "20px" }}>
          {step === "email"
            ? "Укажите почту — пришлём код для входа. Если аккаунта ещё нет, он создастся автоматически."
            : `Код отправлен на ${email.trim()}`}
        </div>

        <div style={{ marginTop: 28 }}>
          {step === "email" ? (
            <>
              <div style={label}>Электронная почта</div>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@mail.com"
                value={email}
                autoFocus
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void sendCode()}
                style={input}
              />
              <button type="button" style={primaryBtn(validEmail && !busy)} disabled={!validEmail || busy} onClick={() => void sendCode()}>
                {busy ? "Отправляем…" : "Получить код"}
              </button>
            </>
          ) : (
            <>
              <div style={label}>Код из письма</div>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="______"
                value={code}
                autoFocus
                maxLength={6}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && void confirmCode()}
                style={{ ...input, letterSpacing: "8px", textAlign: "center", fontSize: 22, fontWeight: 700 }}
              />
              <button type="button" style={primaryBtn(code.trim().length >= 4 && !busy)} disabled={code.trim().length < 4 || busy} onClick={() => void confirmCode()}>
                {busy ? "Проверяем…" : "Войти"}
              </button>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <button type="button" style={linkBtn} onClick={() => { setStep("email"); setCode(""); setError(""); setInfo(""); }}>
                  Изменить почту
                </button>
                <button
                  type="button"
                  style={{ ...linkBtn, color: resendIn > 0 ? "#666" : "#F18726", cursor: resendIn > 0 ? "default" : "pointer" }}
                  disabled={resendIn > 0}
                  onClick={() => void sendCode()}
                >
                  {resendIn > 0 ? `Повторить через ${resendIn}с` : "Отправить снова"}
                </button>
              </div>
            </>
          )}
        </div>

        {info && <div style={{ marginTop: 16, color: "#9BD08B", fontSize: 13 }}>{info}</div>}
        {error && <div style={{ marginTop: 16, color: "#FF8F8F", fontSize: 13 }}>{error}</div>}

        {oauthUrl && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "28px 0 20px", opacity: 0.4 }}>
              <div style={{ flex: 1, height: 1, background: "#555" }} />
              <span style={{ fontSize: 13 }}>или</span>
              <div style={{ flex: 1, height: 1, background: "#555" }} />
            </div>
            <button
              type="button"
              onClick={() => window.location.assign(oauthUrl)}
              style={{
                width: "100%",
                height: 54,
                borderRadius: 30,
                border: "none",
                background: "#2AABEE",
                color: "#fff",
                fontSize: 16,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Войти через Telegram
            </button>
          </>
        )}
      </div>
    </div>
  );
}
