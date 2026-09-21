import React, { useEffect, useState } from "react";
import { BackCircleButton, LoadingScreen, MSIcon } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { AppUser, bindTelegram, fetchMe, logout, unbindEmail, updateEmail } from "../utils/api";

// Определяем, открыто ли приложение внутри Telegram (влияет на правила привязки).
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

  // Конфиг Telegram OAuth (для привязки/смены Telegram на вебе).
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
      } catch {
        /* ignore */
      }
    })();
  }, [inTelegram]);

  // Возврат от Telegram OAuth (?id=...&hash=...) → привязываем.
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

  const frame: React.CSSProperties = {
    position: "relative",
    width: "402px",
    minHeight: "803px",
    background: "#212121",
    overflow: "hidden",
    boxSizing: "border-box",
    padding: "84px 26px 40px",
  };
  const card: React.CSSProperties = {
    background: "#333333",
    borderRadius: "30px",
    padding: "18px",
  };
  const row: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    background: "#3D3D3D",
    borderRadius: "22px",
    padding: "14px 16px",
  };
  const iconBox: React.CSSProperties = {
    width: 44,
    height: 44,
    borderRadius: 12,
    background: "#484848",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };
  const primaryBtn: React.CSSProperties = {
    height: 44,
    background: "#F18726",
    borderRadius: 22,
    border: "none",
    color: "#fff",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    padding: "0 18px",
  };
  const ghostBtn: React.CSSProperties = {
    height: 38,
    background: "#484848",
    borderRadius: 20,
    border: "none",
    color: "#E3E3E3",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    padding: "0 16px",
  };
  const sub: React.CSSProperties = { color: "#8A8A8A", fontSize: 13, fontWeight: 500 };

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-start", minHeight: "100vh", background: "#111", fontFamily: "'Inter', sans-serif" }}>
      <div style={frame}>
        <BackCircleButton onClick={goBack} />
        <div style={{ position: "absolute", left: "73px", top: "28px", fontWeight: 600, fontSize: "27px", lineHeight: "33px", color: "#FFFFFF" }}>
          Безопасность
        </div>

        {/* Заголовочная карточка */}
        <div style={{ ...card, display: "flex", alignItems: "center", gap: 16, marginBottom: 18 }}>
          <div style={iconBox}>
            <MSIcon name="shield" style={{ color: "#E3E3E3", fontSize: 26 }} />
          </div>
          <div>
            <div style={{ color: "#fff", fontSize: 18, fontWeight: 700 }}>Безопасность</div>
            <div style={sub}>Способы входа и восстановление доступа</div>
          </div>
        </div>

        {/* Способы входа */}
        <div style={card}>
          <div style={{ color: "#fff", fontSize: 15, fontWeight: 600, marginBottom: 14, paddingLeft: 4 }}>Способы входа</div>

          {/* Telegram */}
          <div style={{ ...row, marginBottom: 12 }}>
            <div style={iconBox}>
              <MSIcon name="send" style={{ color: "#2AABEE", fontSize: 24 }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: "#fff", fontSize: 16, fontWeight: 600 }}>Telegram</div>
              <div style={sub}>{hasTelegram ? "Привязано" : "Не привязано"}</div>
            </div>
            {inTelegram ? (
              hasTelegram && <MSIcon name="check_circle" style={{ color: "#4CAF50", fontSize: 24 }} />
            ) : (
              <button type="button" style={ghostBtn} disabled={busy} onClick={telegramAction}>
                {hasTelegram ? "Изменить" : "Привязать"}
              </button>
            )}
          </div>

          {/* Email */}
          <div style={{ ...row, flexWrap: "wrap" }}>
            <div style={iconBox}>
              <MSIcon name="mail" style={{ color: "#E3E3E3", fontSize: 24 }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: "#fff", fontSize: 16, fontWeight: 600 }}>Email</div>
              <div style={{ ...sub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {hasEmail ? user?.email : "Не привязано"}
              </div>
            </div>
            {!editEmail && hasEmail && <MSIcon name="check_circle" style={{ color: "#4CAF50", fontSize: 24 }} />}

            {editEmail ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", marginTop: 4 }}>
                <input
                  type="email"
                  value={emailDraft}
                  onChange={(e) => setEmailDraft(e.target.value)}
                  placeholder="you@mail.com"
                  autoFocus
                  style={{ height: 44, borderRadius: 14, border: "1px solid #555", background: "#2B2B2B", color: "#fff", padding: "0 14px", fontSize: 15, outline: "none" }}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" style={{ ...primaryBtn, flex: 1, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={() => void saveEmail()}>
                    Сохранить
                  </button>
                  <button type="button" style={ghostBtn} disabled={busy} onClick={() => { setEditEmail(false); setError(""); }}>
                    Отмена
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, width: "100%", marginTop: 6, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  style={ghostBtn}
                  onClick={() => { setEmailDraft(user?.email || ""); setEditEmail(true); setError(""); }}
                >
                  {hasEmail ? "Изменить" : "Привязать"}
                </button>
                {hasEmail && hasTelegram && (
                  <button type="button" style={{ ...ghostBtn, color: "#FF6B6B" }} disabled={busy} onClick={() => void removeEmail()}>
                    Отвязать
                  </button>
                )}
              </div>
            )}
          </div>

          {error && <div style={{ color: "#FF6B6B", fontSize: 13, marginTop: 12, paddingLeft: 4 }}>{error}</div>}
        </div>

        {/* Подсказка по правилам привязки */}
        <div style={{ ...sub, marginTop: 16, lineHeight: "18px", paddingLeft: 4, paddingRight: 4 }}>
          {inTelegram
            ? "Вы вошли через Telegram. Почту можно привязать, изменить или отвязать. Telegram остаётся основным способом входа."
            : "Вы вошли по почте. Telegram можно привязать или изменить, но не отвязать полностью."}
        </div>

        {!inTelegram && (
          <button
            type="button"
            style={{ ...ghostBtn, width: "100%", height: 48, marginTop: 22, color: "#FF6B6B" }}
            onClick={async () => {
              await logout();
              window.location.assign("/");
            }}
          >
            Выйти из аккаунта
          </button>
        )}
      </div>
    </div>
  );
}
