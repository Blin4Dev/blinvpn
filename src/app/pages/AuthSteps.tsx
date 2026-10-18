import React, { useCallback, useEffect, useRef, useState } from "react";
import { MSIcon, T, btnReset } from "../components/ui";
import { CaptchaBox, type CaptchaPublic } from "../components/CaptchaBox";
import { PrimaryButton, Spinner, Sub, Title, glassCard, haptic, secondaryBtn } from "../components/onbUi";
import { requestEmailCode, verifyEmailCode, type EmailRequestResult, type TelegramOAuthPayload } from "../utils/api";

/* шаги входа на сайте (email → код) в стиле онбординга */

export type AuthConfig = {
  botUsername: string;
  botId: string;
  captcha: CaptchaPublic | null;
};

const CODE_LEN = 6;

function useCaptcha(cfg: CaptchaPublic | null) {
  const [token, setToken] = useState("");
  const [reset, setReset] = useState(0);
  const need = Boolean(cfg?.enabled && cfg.siteKey);
  const bump = useCallback(() => {
    setToken("");
    setReset((n) => n + 1);
  }, []);
  return { token, setToken, reset, bump, need, ok: !need || Boolean(token) };
}

/* ───────── шаг 1: почта ───────── */

export function EmailStep({
  cfg,
  initialEmail,
  onSent,
  onTelegram,
}: {
  cfg: AuthConfig;
  initialEmail: string;
  onSent: (email: string, r: EmailRequestResult) => void;
  onTelegram: (payload: TelegramOAuthPayload) => Promise<void>;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [focus, setFocus] = useState(false);
  const cap = useCaptcha(cfg.captcha);
  const valid = /\S+@\S+\.\S+/.test(email.trim());
  // telegram.org недоступен (РФ без VPN) — блок «или / через Telegram» не показываем
  const [tgOff, setTgOff] = useState(false);

  const send = async () => {
    if (busy || !valid) return;
    if (!cap.ok) {
      setErr("Пройдите проверку «я не робот»");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const r = await requestEmailCode(email.trim(), cap.token || undefined);
      onSent(email.trim(), r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось отправить код");
      haptic()?.notificationOccurred?.("error");
      cap.bump();
      setBusy(false);
    }
  };

  return (
    <>
      <Title i={1}>Вход в BlinVPN</Title>
      <Sub i={2}>Введите почту — пришлём код для входа. Пароль не нужен.</Sub>
      <label
        className="blin-onb-item"
        style={{
          ["--i" as string]: 3,
          ...glassCard,
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 18px",
          height: 60,
          borderColor: err ? "rgba(255, 92, 92, 0.45)" : focus ? "rgba(255, 107, 26, 0.5)" : T.borderStrong,
          transition: "border-color 0.25s ease",
          cursor: "text",
        }}
      >
        <MSIcon name="mail" style={{ fontSize: 22, color: focus || email ? T.orange : T.textDim, transition: "color 0.25s ease" }} />
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@mail.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (err) setErr("");
          }}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          onKeyDown={(e) => e.key === "Enter" && void send()}
          style={{
            flex: 1,
            minWidth: 0,
            height: "100%",
            border: "none",
            outline: "none",
            background: "transparent",
            color: T.text,
            fontSize: 17,
            fontFamily: T.font,
            padding: 0,
          }}
        />
      </label>
      {cap.need ? (
        <div className="blin-onb-item" style={{ ["--i" as string]: 4 }}>
          <CaptchaBox cfg={cfg.captcha} onToken={cap.setToken} resetKey={cap.reset} />
        </div>
      ) : null}
      <div style={{ height: 16 }} />
      <PrimaryButton i={4} disabled={!valid || busy || !cap.ok} onClick={() => void send()}>
        {busy ? <Spinner /> : null}
        {busy ? "Отправляем…" : "Получить код"}
      </PrimaryButton>
      {err ? <ErrorText>{err}</ErrorText> : null}
      {cfg.botUsername && cfg.botId && !tgOff ? (
        <>
          <div className="blin-onb-item" style={{ ["--i" as string]: 5, display: "flex", alignItems: "center", gap: 12, margin: "18px 0 14px" }}>
            <div style={{ flex: 1, height: 1, background: T.border }} />
            <span style={{ fontSize: 13, color: T.textDim }}>или</span>
            <div style={{ flex: 1, height: 1, background: T.border }} />
          </div>
          <div className="blin-onb-item" style={{ ["--i" as string]: 6 }}>
            <TelegramButton cfg={cfg} onAuth={onTelegram} onUnavailable={() => setTgOff(true)} />
          </div>
        </>
      ) : null}
    </>
  );
}

/* вход через telegram: своя кнопка (Telegram.Login.auth), иначе — официальный виджет */
type TgLogin = { auth?: (o: { bot_id: string; request_access?: string }, cb: (u: TelegramOAuthPayload | false) => void) => void };
function tgLogin(): TgLogin | null {
  try {
    return (window as unknown as { Telegram?: { Login?: TgLogin } }).Telegram?.Login ?? null;
  } catch {
    return null;
  }
}

function TelegramButton({ cfg, onAuth, onUnavailable }: { cfg: AuthConfig; onAuth: (p: TelegramOAuthPayload) => Promise<void>; onUnavailable: () => void }) {
  const [ready, setReady] = useState(() => Boolean(tgLogin()?.auth));
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (ready || !cfg.botId) return;
    const id = "blin-tg-login-js";
    let s = document.getElementById(id) as HTMLScriptElement | null;
    const onLoad = () => (tgLogin()?.auth ? setReady(true) : setFailed(true));
    if (!s) {
      s = document.createElement("script");
      s.id = id;
      s.src = "https://telegram.org/js/telegram-widget.js?22";
      s.async = true;
      document.head.appendChild(s);
    }
    s.addEventListener("load", onLoad);
    s.addEventListener("error", () => setFailed(true));
    const t = window.setTimeout(() => !tgLogin()?.auth && setFailed(true), 5000);
    return () => {
      s?.removeEventListener("load", onLoad);
      window.clearTimeout(t);
    };
  }, [ready, cfg.botId]);

  useEffect(() => {
    if (failed) onUnavailable();
  }, [failed, onUnavailable]);
  if (failed) return null;

  const start = () => {
    const api = tgLogin();
    if (!api?.auth || busy) return;
    setErr("");
    api.auth({ bot_id: cfg.botId, request_access: "write" }, (user) => {
      if (!user) return;
      setBusy(true);
      onAuth(user).catch((e) => {
        setErr(e instanceof Error ? e.message : "Не удалось войти через Telegram");
        setBusy(false);
      });
    });
  };

  return (
    <>
      <button type="button" className="blin-press" disabled={busy} onClick={start} style={{ ...secondaryBtn, opacity: ready ? 1 : 0.6 }}>
        {busy ? <Spinner muted /> : <TelegramGlyph />}
        {busy ? "Входим…" : "Войти через Telegram"}
      </button>
      {err ? <ErrorText>{err}</ErrorText> : null}
    </>
  );
}

function TelegramGlyph() {
  // нейтральный «самолётик», без фирменного логотипа
  return <MSIcon name="send" style={{ fontSize: 20, color: T.textMuted, transform: "rotate(-20deg)" }} />;
}

/* ───────── шаг 2: код ───────── */

export function CodeStep({
  cfg,
  email,
  resendAfter,
  devCode,
  onBack,
  onResent,
  onVerified,
}: {
  cfg: AuthConfig;
  email: string;
  resendAfter: number;
  devCode?: string;
  onBack: () => void;
  onResent: (r: EmailRequestResult) => void;
  /** вход выполнен; промис — подготовка следующих шагов (кнопка крутится до конца) */
  onVerified: () => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [shake, setShake] = useState(0);
  const [left, setLeft] = useState(resendAfter);
  const cap = useCaptcha(cfg.captcha);

  useEffect(() => setLeft(resendAfter), [resendAfter]);
  useEffect(() => {
    if (left <= 0) return;
    const t = window.setTimeout(() => setLeft((v) => v - 1), 1000);
    return () => window.clearTimeout(t);
  }, [left]);

  const verify = async (value = code) => {
    if (busy || value.length < CODE_LEN) return;
    setBusy(true);
    setErr("");
    try {
      // капча уже пройдена при отправке кода
      await verifyEmailCode(email, value);
      haptic()?.notificationOccurred?.("success");
      await onVerified();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Неверный код");
      setShake((s) => s + 1);
      setCode("");
      haptic()?.notificationOccurred?.("error");
      setBusy(false);
    }
  };

  const resend = async () => {
    if (left > 0 || busy) return;
    if (!cap.ok) {
      setErr("Пройдите проверку «я не робот»");
      return;
    }
    setErr("");
    try {
      const r = await requestEmailCode(email, cap.token || undefined);
      onResent(r);
      setLeft(r.resend_after || 60);
      cap.bump();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось отправить код");
      cap.bump();
    }
  };

  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");

  return (
    <>
      <Title i={1}>Введите код</Title>
      <div className="blin-onb-item" style={{ ["--i" as string]: 2, fontSize: 16, lineHeight: 1.45, color: T.textMuted, marginTop: 12, marginBottom: 24 }}>
        Отправили {CODE_LEN} цифр на <span style={{ color: T.text, fontWeight: 500, wordBreak: "break-all" }}>{email}</span>
        {" · "}
        <button
          type="button"
          onClick={onBack}
          style={{ ...btnReset, border: "none", background: "transparent", padding: 0, color: T.orangeBright, fontSize: "inherit", fontWeight: 500, cursor: "pointer" }}
        >
          изменить
        </button>
      </div>
      <div className="blin-onb-item" style={{ ["--i" as string]: 3 }}>
        <div key={shake} className={shake ? "blin-onb-shake" : undefined}>
          <OtpInput
            value={code}
            error={Boolean(err)}
            disabled={busy}
            onChange={(v) => {
              setCode(v);
              if (err) setErr("");
              if (v.length === CODE_LEN) void verify(v);
            }}
          />
        </div>
      </div>
      {devCode ? (
        <div style={{ fontSize: 13, color: T.success, marginTop: 10, textAlign: "center" }}>Код (демо-режим): {devCode}</div>
      ) : null}
      <div style={{ height: 16 }} />
      <PrimaryButton i={4} disabled={code.length < CODE_LEN || busy} onClick={() => void verify()}>
        {busy ? <Spinner /> : null}
        {busy ? "Входим…" : "Войти"}
      </PrimaryButton>
      {err ? <ErrorText>{err}</ErrorText> : null}
      <div className="blin-onb-item" style={{ ["--i" as string]: 5, textAlign: "center", marginTop: 14 }}>
        <button
          type="button"
          disabled={left > 0}
          onClick={() => void resend()}
          style={{
            ...btnReset,
            border: "none",
            background: "transparent",
            padding: "6px 8px",
            fontSize: 14,
            fontWeight: 500,
            color: left > 0 ? T.textDim : T.orangeBright,
            cursor: left > 0 ? "default" : "pointer",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {left > 0 ? `Отправить ещё раз через ${mm}:${ss}` : "Отправить код ещё раз"}
        </button>
      </div>
      {/* капча нужна только для повторной отправки письма */}
      {cap.need && left <= 0 ? (
        <div style={{ marginTop: 8, animation: "blinvpnFadeIn 0.25s ease both" }}>
          <CaptchaBox cfg={cfg.captcha} onToken={cap.setToken} resetKey={cap.reset} />
        </div>
      ) : null}
    </>
  );
}

/* 6 ячеек поверх одного настоящего инпута (автоподстановка кода из письма/СМС работает) */
function OtpInput({ value, onChange, error, disabled }: { value: string; onChange: (v: string) => void; error: boolean; disabled: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    // фокус после въезда шага
    const t = window.setTimeout(() => ref.current?.focus({ preventScroll: true }), 650);
    return () => window.clearTimeout(t);
  }, []);
  const active = Math.min(value.length, CODE_LEN - 1);

  return (
    <div style={{ position: "relative" }} onClick={() => ref.current?.focus()}>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${CODE_LEN}, 1fr)`, gap: 8 }}>
        {Array.from({ length: CODE_LEN }, (_, i) => {
          const ch = value[i] || "";
          const isActive = focus && !disabled && i === active && value.length < CODE_LEN;
          return (
            <div
              key={i}
              style={{
                ...glassCard,
                borderRadius: 16,
                height: 62,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 26,
                fontWeight: 700,
                color: T.text,
                fontVariantNumeric: "tabular-nums",
                borderColor: error
                  ? "rgba(255, 92, 92, 0.55)"
                  : isActive
                    ? "rgba(255, 107, 26, 0.75)"
                    : ch
                      ? "rgba(255, 107, 26, 0.3)"
                      : T.borderStrong,
                boxShadow: isActive ? "0 0 0 4px rgba(255, 107, 26, 0.12)" : "none",
                transition: "border-color 0.2s ease, box-shadow 0.2s ease",
              }}
            >
              {ch ? (
                <span key={ch + i} className="blin-otp-digit">{ch}</span>
              ) : isActive ? (
                <span className="blin-otp-caret" />
              ) : null}
            </div>
          );
        })}
      </div>
      <input
        ref={ref}
        value={value}
        disabled={disabled}
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="Код из письма"
        maxLength={CODE_LEN}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, CODE_LEN))}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          opacity: 0.01,
          border: "none",
          background: "transparent",
          color: "transparent",
          caretColor: "transparent",
          fontSize: 16,
          letterSpacing: 40,
        }}
      />
    </div>
  );
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 13, color: T.danger, marginTop: 10, textAlign: "center", animation: "blinvpnFadeIn 0.25s ease both" }}>{children}</div>;
}
