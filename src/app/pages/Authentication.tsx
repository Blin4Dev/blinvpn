import React, { useCallback, useEffect, useMemo, useState } from "react";
import { BrandMark, Btn, Field, LoadingScreen, T, pageFrame, pageOuter } from "../components/ui";
import { CaptchaBox, type CaptchaPublic } from "../components/CaptchaBox";
import { TelegramLoginWidget } from "../components/TelegramLoginWidget";
import {
  appFetch,
  requestEmailCode,
  setAppToken,
  verifyEmailCode,
  getWebRef,
  type AppUser,
  type TelegramOAuthPayload,
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
  const [botUsername, setBotUsername] = useState("");
  const [oauthBusy, setOauthBusy] = useState(false);
  const [captcha, setCaptcha] = useState<CaptchaPublic | null>(null);
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaReset, setCaptchaReset] = useState(0);

  const validEmail = useMemo(() => /\S+@\S+\.\S+/.test(email.trim()), [email]);
  const needCaptcha = Boolean(captcha?.enabled && captcha.siteKey);
  const captchaOk = !needCaptcha || Boolean(captchaToken);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/app/config");
        const body = (await res.json().catch(() => null)) as {
          botUsername?: string;
          captcha?: CaptchaPublic;
        } | null;
        if (!res.ok || !body) return;
        if (typeof body.botUsername === "string" && body.botUsername.trim()) {
          setBotUsername(body.botUsername.trim().replace(/^@/, ""));
        }
        if (body.captcha && typeof body.captcha === "object") {
          setCaptcha(body.captcha);
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const bumpCaptcha = () => {
    setCaptchaToken("");
    setCaptchaReset((n) => n + 1);
  };

  const finishOauth = useCallback(
    async (payload: TelegramOAuthPayload) => {
      // Telegram Login Widget уже подписан — капча не нужна
      setOauthBusy(true);
      setError("");
      try {
        const clean: Record<string, string | number> = { id: payload.id, hash: payload.hash };
        if (payload.first_name) clean.first_name = payload.first_name;
        if (payload.last_name) clean.last_name = payload.last_name;
        if (payload.username) clean.username = payload.username;
        if (payload.photo_url) clean.photo_url = payload.photo_url;
        if (payload.auth_date != null && payload.auth_date !== "") clean.auth_date = payload.auth_date;

        const ref = getWebRef();
        const b = await appFetch<{ user?: AppUser; token?: string }>("/auth/oauth", {
          method: "POST",
          body: JSON.stringify(ref ? { ...clean, ref } : clean),
        });
        if (b.token) setAppToken(b.token);
        onAuthed();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Не удалось войти через Telegram");
        setOauthBusy(false);
      }
    },
    [onAuthed],
  );

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const sendCode = useCallback(async () => {
    if (busy || !validEmail) return;
    if (needCaptcha && !captchaToken) {
      setError("Пройдите проверку «я не робот»");
      return;
    }
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const r = await requestEmailCode(email.trim(), captchaToken || undefined);
      setStep("code");
      setResendIn(r.resend_after || 60);
      setInfo(
        r.dev_code
          ? `Код (демо-режим): ${r.dev_code}`
          : "Мы отправили код на вашу почту. Проверьте входящие.",
      );
      bumpCaptcha();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отправить код");
      bumpCaptcha();
    } finally {
      setBusy(false);
    }
  }, [busy, email, validEmail, needCaptcha, captchaToken]);

  const confirmCode = useCallback(async () => {
    if (busy || code.trim().length < 4) return;
    if (needCaptcha && !captchaToken) {
      setError("Пройдите проверку «я не робот»");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await verifyEmailCode(email.trim(), code.trim(), captchaToken || undefined);
      onAuthed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Неверный код");
      bumpCaptcha();
    } finally {
      setBusy(false);
    }
  }, [busy, code, email, onAuthed, needCaptcha, captchaToken]);

  if (oauthBusy) return <LoadingScreen text="Входим через Telegram…" />;

  return (
    <div style={pageOuter()}>
      <div style={pageFrame({ padding: "56px 26px 40px" })}>
        <div style={{ position: "relative", zIndex: 1 }}>
          <BrandMark size="lg" />
          <div style={{ fontWeight: 600, fontSize: 22, marginTop: 36, letterSpacing: "-0.02em", color: T.text }}>
            {step === "email" ? "Вход" : "Введите код"}
          </div>
          <div style={{ marginTop: 8, color: T.textMuted, fontSize: 14, lineHeight: 1.5 }}>
            {step === "email"
              ? "Пришлём код на почту"
              : `Код отправлен на ${email.trim()}`}
          </div>

          <div style={{ marginTop: 28 }}>
            {step === "email" ? (
              <>
                <div style={{ fontSize: 13, fontWeight: 500, color: T.textMuted, marginBottom: 8 }}>
                  Электронная почта
                </div>
                <Field
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@mail.com"
                  value={email}
                  autoFocus
                  onChange={setEmail}
                  onKeyDown={(e) => e.key === "Enter" && void sendCode()}
                />
                <CaptchaBox cfg={captcha} onToken={setCaptchaToken} resetKey={captchaReset} />
                <Btn
                  disabled={!validEmail || busy || !captchaOk}
                  onClick={() => void sendCode()}
                  style={{ marginTop: 16 }}
                >
                  {busy ? "Отправляем…" : "Получить код"}
                </Btn>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, fontWeight: 500, color: T.textMuted, marginBottom: 8 }}>
                  Код из письма
                </div>
                <Field
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="______"
                  value={code}
                  autoFocus
                  maxLength={6}
                  onChange={(v) => setCode(v.replace(/\D/g, ""))}
                  onKeyDown={(e) => e.key === "Enter" && void confirmCode()}
                  style={{ letterSpacing: 8, textAlign: "center", fontSize: 22, fontWeight: 700 }}
                />
                <CaptchaBox cfg={captcha} onToken={setCaptchaToken} resetKey={captchaReset} />
                <Btn
                  disabled={code.trim().length < 4 || busy || !captchaOk}
                  onClick={() => void confirmCode()}
                  style={{ marginTop: 16 }}
                >
                  {busy ? "Проверяем…" : "Войти"}
                </Btn>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
                  <button
                    type="button"
                    style={{
                      background: "none",
                      border: "none",
                      color: T.orange,
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: "pointer",
                      fontFamily: T.font,
                      padding: 0,
                    }}
                    onClick={() => {
                      setStep("email");
                      setCode("");
                      setError("");
                      setInfo("");
                      bumpCaptcha();
                    }}
                  >
                    Изменить почту
                  </button>
                  <button
                    type="button"
                    disabled={resendIn > 0}
                    style={{
                      background: "none",
                      border: "none",
                      color: resendIn > 0 ? T.textDim : T.orange,
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: resendIn > 0 ? "default" : "pointer",
                      fontFamily: T.font,
                      padding: 0,
                    }}
                    onClick={() => void sendCode()}
                  >
                    {resendIn > 0 ? `Повторить через ${resendIn}с` : "Отправить снова"}
                  </button>
                </div>
              </>
            )}
          </div>

          {info && <div style={{ marginTop: 16, color: T.success, fontSize: 13 }}>{info}</div>}
          {error && <div style={{ marginTop: 16, color: T.danger, fontSize: 13 }}>{error}</div>}

          {botUsername && step === "email" ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "28px 0 20px" }}>
                <div style={{ flex: 1, height: 1, background: T.border }} />
                <span style={{ fontSize: 13, color: T.textDim }}>или</span>
                <div style={{ flex: 1, height: 1, background: T.border }} />
              </div>
              <TelegramLoginWidget
                botUsername={botUsername}
                onAuth={(u) => void finishOauth(u)}
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
