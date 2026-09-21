import React, { useEffect, useState } from "react";
import { Btn, Field, LoadingScreen, MSIcon, PageHeader, Screen, SectionLabel, Surface, T, btnReset } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { AppUser, bindTelegram, fetchMe, logout, unbindEmail, updateEmail } from "../utils/api";

function isTelegramContext(): boolean {
  try {
    const wa = (window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp;
    return Boolean(wa?.initData && wa.initData.length > 0);
  } catch {
    return false;
  }
}

export default function Security() {
  const goBack = useSmartBack("/settings");
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editEmail, setEditEmail] = useState(false);
  const [emailDraft, setEmailDraft] = useState("");
  const [error, setError] = useState("");
  const inTelegram = isTelegramContext();
  const [oauthUrl, setOauthUrl] = useState("");

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
        const body = (await res.json().catch(() => null)) as
          | { telegramOauthBotId?: string; telegramOauthUrl?: string }
          | null;
        if (!res.ok || !body) return;
        const returnTo = `${window.location.origin}/security`;
        if (body.telegramOauthUrl) setOauthUrl(body.telegramOauthUrl);
        else if (body.telegramOauthBotId) {
          setOauthUrl(
            `https://oauth.telegram.org/auth?bot_id=${encodeURIComponent(body.telegramOauthBotId)}&origin=${encodeURIComponent(window.location.origin)}&return_to=${encodeURIComponent(returnTo)}&request_access=write`,
          );
        }
      } catch { /* ignore */ }
    })();
  }, [inTelegram]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.get("hash") || !params.get("id")) return;
    const FIELDS = ["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"] as const;
    const payload = Object.fromEntries(
      FIELDS.flatMap((k) => {
        const v = params.get(k);
        return v !== null ? [[k, v]] : [];
      }),
    ) as Parameters<typeof bindTelegram>[0];
    setBusy(true);
    void (async () => {
      try {
        const updated = await bindTelegram(payload);
        setUser(updated);
        window.history.replaceState({}, "", "/security");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Не удалось привязать Telegram");
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  const telegramAction = () => {
    if (oauthUrl) window.location.assign(oauthUrl);
    else setError("Вход через Telegram не настроен на сервере");
  };

  const hasTelegram = Boolean(user?.telegram_id);
  const hasEmail = Boolean(user?.email);

  const saveEmail = async () => {
    const value = emailDraft.trim().toLowerCase();
    if (!value || !value.includes("@")) {
      setError("Введите корректный email");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const updated = await updateEmail(value);
      setUser(updated);
      setEditEmail(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
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
              onClick={telegramAction}
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
            {!editEmail && hasEmail ? (
              <MSIcon name="check" style={{ color: T.success, fontSize: 22 }} />
            ) : null}
          </div>

          {editEmail ? (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              <Field
                type="email"
                value={emailDraft}
                onChange={setEmailDraft}
                placeholder="you@mail.com"
                autoFocus
              />
              <div style={{ display: "flex", gap: 8 }}>
                <Btn disabled={busy} onClick={() => void saveEmail()} style={{ flex: 1 }}>
                  Сохранить
                </Btn>
                <Btn
                  variant="secondary"
                  disabled={busy}
                  onClick={() => { setEditEmail(false); setError(""); }}
                  style={{ flex: 1 }}
                >
                  Отмена
                </Btn>
              </div>
            </div>
          ) : (
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
                onClick={() => { setEmailDraft(user?.email || ""); setEditEmail(true); setError(""); }}
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
          )}
        </div>
      </Surface>

      {error ? <div style={{ color: T.danger, fontSize: 13, marginTop: 12 }}>{error}</div> : null}

      <div style={{ fontSize: 13, color: T.textDim, lineHeight: 1.45, marginTop: 16 }}>
        {inTelegram
          ? "Вы вошли через Telegram. Почту можно привязать или изменить. Telegram остаётся основным способом входа."
          : "Вы вошли по почте. Telegram можно привязать или изменить, но не отвязать полностью."}
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
