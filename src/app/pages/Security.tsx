import React, { useEffect, useState } from "react";
import { Btn, Field, LoadingScreen, MSIcon, PageHeader, Screen, SectionLabel, Surface, T, btnReset } from "../components/ui";
import { TelegramLoginWidget } from "../components/TelegramLoginWidget";
import { useSmartBack } from "../utils/navigation";
import {
  AppUser,
  bindTelegram,
  fetchMe,
  logout,
  requestBindEmailCode,
  unbindEmail,
  updateEmail,
  mergeFromError,
  type MergePreview,
  type TelegramOAuthPayload,
} from "../utils/api";
import ConfirmDialog from "../components/ConfirmDialog";

/** Текст предупреждения об объединении аккаунтов. */
function MergeText({ m, what }: { m: MergePreview; what: string }) {
  return (
    <>
      <div style={{ marginBottom: 10 }}>
        {what} уже привязан к другому аккаунту ({m.other.label}). Если продолжить, аккаунты объединятся в этот:
      </div>
      <div style={{ whiteSpace: "pre-line", color: T.text, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "10px 12px" }}>
        {m.text}
      </div>
    </>
  );
}

function isTelegramContext(): boolean {
  try {
    const wa = (window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp;
    return Boolean(wa?.initData && wa.initData.length > 0);
  } catch {
    return false;
  }
}

type EmailStep = "idle" | "email" | "code";

export default function Security() {
  const goBack = useSmartBack("/settings");
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [emailStep, setEmailStep] = useState<EmailStep>("idle");
  const [emailDraft, setEmailDraft] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const inTelegram = isTelegramContext();
  const [botUsername, setBotUsername] = useState("");
  const [showTgWidget, setShowTgWidget] = useState(false);
  // Объединение аккаунтов: предупреждение перед привязкой email/Telegram, который уже занят
  const [emailMerge, setEmailMerge] = useState<MergePreview | null>(null);
  const [emailMergeOk, setEmailMergeOk] = useState(false);
  const [tgMerge, setTgMerge] = useState<{ m: MergePreview; payload: TelegramOAuthPayload } | null>(null);

  const load = async () => {
    const me = await fetchMe();
    setUser(me);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (inTelegram) return;
    void (async () => {
      try {
        const res = await fetch("/api/app/config");
        const body = (await res.json().catch(() => null)) as { botUsername?: string } | null;
        if (!res.ok || !body) return;
        if (typeof body.botUsername === "string" && body.botUsername.trim()) {
          setBotUsername(body.botUsername.trim().replace(/^@/, ""));
        }
      } catch {
        /* ignore */
      }
    })();
  }, [inTelegram]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const onTgAuth = async (payload: TelegramOAuthPayload) => {
    setBusy(true);
    setError("");
    try {
      const clean: TelegramOAuthPayload = { id: payload.id, hash: payload.hash };
      if (payload.first_name) clean.first_name = payload.first_name;
      if (payload.last_name) clean.last_name = payload.last_name;
      if (payload.username) clean.username = payload.username;
      if (payload.photo_url) clean.photo_url = payload.photo_url;
      if (payload.auth_date != null && payload.auth_date !== "") clean.auth_date = payload.auth_date;
      const updated = await bindTelegram(clean);
      setUser(updated);
      setShowTgWidget(false);
    } catch (e) {
      const m = mergeFromError(e);
      if (m) {
        setTgMerge({ m, payload: { ...payload } });
        return;
      }
      setError(e instanceof Error ? e.message : "Не удалось привязать Telegram");
    } finally {
      setBusy(false);
    }
  };

  const confirmTgMerge = async () => {
    if (!tgMerge) return;
    setBusy(true);
    setError("");
    try {
      const p = tgMerge.payload;
      const clean: TelegramOAuthPayload = { id: p.id, hash: p.hash };
      if (p.first_name) clean.first_name = p.first_name;
      if (p.last_name) clean.last_name = p.last_name;
      if (p.username) clean.username = p.username;
      if (p.photo_url) clean.photo_url = p.photo_url;
      if (p.auth_date != null && p.auth_date !== "") clean.auth_date = p.auth_date;
      const updated = await bindTelegram(clean, true);
      setUser(updated);
      setShowTgWidget(false);
      setInfo("Аккаунты объединены");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось объединить аккаунты");
    } finally {
      setTgMerge(null);
      setBusy(false);
    }
  };

  const hasTelegram = Boolean(user?.telegram_id);
  const hasEmail = Boolean(user?.email);

  const sendEmailCode = async () => {
    const value = emailDraft.trim().toLowerCase();
    if (!value || !value.includes("@")) {
      setError("Введите корректный email");
      return;
    }
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const r = await requestBindEmailCode(value);
      setEmailMerge(r.merge ?? null);
      setEmailMergeOk(false);
      setEmailStep("code");
      setResendIn(r.resend_after || 60);
      setInfo(
        r.dev_code
          ? `Код (демо-режим): ${r.dev_code}`
          : "Код отправлен на почту. Введите его ниже.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отправить код");
    } finally {
      setBusy(false);
    }
  };

  const confirmEmailCode = async () => {
    const value = emailDraft.trim().toLowerCase();
    if (emailCode.trim().length < 4) {
      setError("Введите код из письма");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const updated = await updateEmail(value, emailCode.trim(), emailMergeOk);
      setUser(updated);
      setEmailStep("idle");
      setEmailCode("");
      setInfo(emailMergeOk ? "Аккаунты объединены" : "");
      setEmailMerge(null);
      setEmailMergeOk(false);
    } catch (e) {
      const m = mergeFromError(e);
      if (m) {
        setEmailMerge(m);
        setEmailMergeOk(false);
        return;
      }
      setError(e instanceof Error ? e.message : "Неверный код");
    } finally {
      setBusy(false);
    }
  };

  const removeEmail = async () => {
    setBusy(true);
    setError("");
    try {
      const updated = await unbindEmail();
      setUser(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отвязать");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingScreen />;

  return (
    <Screen>
      <PageHeader title="Безопасность" onBack={goBack} />

      {emailStep === "code" && emailMerge && !emailMergeOk && (
        <ConfirmDialog
          title="Объединить аккаунты?"
          confirmText="Продолжить"
          onConfirm={() => setEmailMergeOk(true)}
          onCancel={() => { setEmailMerge(null); setEmailStep("email"); setEmailCode(""); setInfo(""); }}
        >
          <MergeText m={emailMerge} what="Этот email" />
        </ConfirmDialog>
      )}
      {tgMerge && (
        <ConfirmDialog
          title="Объединить аккаунты?"
          confirmText="Объединить"
          busy={busy}
          onConfirm={() => void confirmTgMerge()}
          onCancel={() => setTgMerge(null)}
        >
          <MergeText m={tgMerge.m} what="Этот Telegram" />
        </ConfirmDialog>
      )}

      <div style={{ fontSize: 14, color: T.textMuted, lineHeight: 1.5, marginBottom: 8 }}>
        Способы входа и восстановление доступа.
      </div>

      <SectionLabel>Способы входа</SectionLabel>
      <Surface padded>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "14px 0",
            borderBottom: `1px solid ${T.border}`,
          }}
        >
          <MSIcon name="send" style={{ color: T.textMuted, fontSize: 22 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500, fontSize: 15, color: T.text }}>Telegram</div>
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 2 }}>
              {hasTelegram ? "Привязано" : "Не привязано"}
            </div>
          </div>
          {inTelegram ? (
            hasTelegram ? <MSIcon name="check" style={{ color: T.success, fontSize: 22 }} /> : null
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setShowTgWidget((v) => !v);
                setError("");
              }}
              className="blin-press"
              style={{
                ...btnReset,
                height: 34,
                padding: "0 12px",
                borderRadius: 10,
                border: `1px solid ${T.border}`,
                background: T.surfaceRaised,
                color: T.text,
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {hasTelegram ? "Изменить" : "Привязать"}
            </button>
          )}
        </div>

        {!inTelegram && showTgWidget && botUsername ? (
          <div style={{ padding: "12px 0 8px" }}>
            <TelegramLoginWidget botUsername={botUsername} onAuth={(u) => void onTgAuth(u)} />
          </div>
        ) : null}
        {!inTelegram && showTgWidget && !botUsername ? (
          <div style={{ fontSize: 13, color: T.danger, padding: "8px 0" }}>
            Вход через Telegram не настроен на сервере
          </div>
        ) : null}

        <div style={{ padding: "14px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <MSIcon name="mail" style={{ color: T.textMuted, fontSize: 22 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, fontSize: 15, color: T.text }}>Email</div>
              <div
                style={{
                  fontSize: 13,
                  color: T.textMuted,
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {hasEmail ? user?.email : "Не привязано"}
              </div>
            </div>
            {emailStep === "idle" && hasEmail ? (
              <MSIcon name="check" style={{ color: T.success, fontSize: 22 }} />
            ) : null}
          </div>

          {emailStep === "email" ? (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              <Field
                type="email"
                value={emailDraft}
                onChange={setEmailDraft}
                placeholder="you@mail.com"
                autoFocus
              />
              <div style={{ display: "flex", gap: 8 }}>
                <Btn disabled={busy} onClick={() => void sendEmailCode()} style={{ flex: 1 }}>
                  {busy ? "Отправляем…" : "Получить код"}
                </Btn>
                <Btn
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setEmailStep("idle");
                    setError("");
                    setInfo("");
                  }}
                  style={{ flex: 1 }}
                >
                  Отмена
                </Btn>
              </div>
            </div>
          ) : null}

          {emailStep === "code" ? (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 13, color: T.textMuted }}>
                Код отправлен на {emailDraft.trim()}
              </div>
              {emailMerge && emailMergeOk && (
                <div style={{ fontSize: 13, color: T.orange, lineHeight: 1.4 }}>
                  После подтверждения аккаунты объединятся: {emailMerge.result.days.toString().replace(".", ",")} дн., {emailMerge.result.devices} устр.
                </div>
              )}
              <Field
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="______"
                value={emailCode}
                autoFocus
                maxLength={6}
                onChange={(v) => setEmailCode(v.replace(/\D/g, ""))}
                style={{ letterSpacing: 8, textAlign: "center", fontSize: 22, fontWeight: 700 }}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <Btn disabled={busy || emailCode.length < 4} onClick={() => void confirmEmailCode()} style={{ flex: 1 }}>
                  {busy ? "Проверяем…" : "Подтвердить"}
                </Btn>
                <Btn
                  variant="secondary"
                  disabled={busy || resendIn > 0}
                  onClick={() => void sendEmailCode()}
                  style={{ flex: 1 }}
                >
                  {resendIn > 0 ? `${resendIn}с` : "Ещё раз"}
                </Btn>
              </div>
              <button
                type="button"
                style={{
                  ...btnReset,
                  color: T.orange,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  alignSelf: "flex-start",
                }}
                onClick={() => {
                  setEmailStep("email");
                  setEmailCode("");
                  setInfo("");
                }}
              >
                Изменить email
              </button>
            </div>
          ) : null}

          {emailStep === "idle" ? (
            <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="blin-press"
                style={{
                  ...btnReset,
                  height: 34,
                  padding: "0 12px",
                  borderRadius: 10,
                  border: `1px solid ${T.border}`,
                  background: T.surfaceRaised,
                  color: T.text,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
                onClick={() => {
                  setEmailDraft(user?.email || "");
                  setEmailStep("email");
                  setEmailCode("");
                  setError("");
                  setInfo("");
                }}
              >
                {hasEmail ? "Изменить" : "Привязать"}
              </button>
              {hasEmail && hasTelegram ? (
                <button
                  type="button"
                  disabled={busy}
                  className="blin-press"
                  style={{
                    ...btnReset,
                    height: 34,
                    padding: "0 12px",
                    borderRadius: 10,
                    border: `1px solid ${T.border}`,
                    background: "transparent",
                    color: T.danger,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                  onClick={() => void removeEmail()}
                >
                  Отвязать
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </Surface>

      {info ? <div style={{ color: T.success, fontSize: 13, marginTop: 12 }}>{info}</div> : null}
      {error ? <div style={{ color: T.danger, fontSize: 13, marginTop: 12 }}>{error}</div> : null}

      <div style={{ fontSize: 13, color: T.textDim, lineHeight: 1.45, marginTop: 16 }}>
        {inTelegram
          ? "Вы вошли через Telegram. Почту можно привязать кодом из письма."
          : "Вы вошли по почте. Telegram можно привязать через виджет ниже, но не отвязать полностью."}
      </div>

      {!inTelegram ? (
        <Btn
          variant="ghost"
          style={{ marginTop: 24, color: T.danger }}
          onClick={async () => {
            await logout();
            window.location.assign("/");
          }}
        >
          Выйти из аккаунта
        </Btn>
      ) : null}
    </Screen>
  );
}
