import React, { useState } from "react";
import { fetchMembership, tgWebApp, type Membership } from "../utils/api";

/**
 * Обязательная подписка на канал (только Telegram-вход). Полноэкранный экран,
 * который нельзя закрыть, пока пользователь не подпишется на основной канал.
 * Второй канал — необязательный.
 */
export default function ChannelGate({
  membership,
  onPassed,
}: {
  membership: Membership;
  onPassed: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState("");

  const mainUrl = membership.channel_url || "https://t.me/blinvpn";
  const optUrl = membership.optional_url || "";

  const openChannel = (url: string) => {
    const wa = tgWebApp();
    if (wa?.openTelegramLink && /^https?:\/\/t\.me\//i.test(url)) wa.openTelegramLink(url);
    else if (wa?.openLink) wa.openLink(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  };

  const recheck = async () => {
    if (checking) return;
    setChecking(true);
    setErr("");
    const m = await fetchMembership(true);
    setChecking(false);
    if (m.subscribed) onPassed();
    else setErr("Мы пока не видим вашу подписку. Подпишитесь и нажмите ещё раз.");
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#111",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Inter', sans-serif",
        padding: "24px",
        boxSizing: "border-box",
        zIndex: 2000,
      }}
    >
      <div style={{ width: "100%", maxWidth: "360px", display: "flex", flexDirection: "column", alignItems: "center", gap: "18px" }}>
        <div
          style={{
            width: 72, height: 72, borderRadius: "50%", background: "rgba(241,135,38,0.16)",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 38,
          }}
        >
          📣
        </div>
        <div style={{ fontWeight: 700, fontSize: "22px", color: "#FFFFFF", textAlign: "center" }}>
          Подпишитесь на канал
        </div>
        <div style={{ fontSize: "14px", lineHeight: "20px", color: "#B9B9B9", textAlign: "center" }}>
          Чтобы пользоваться BlinVPN, подпишитесь на наш основной канал. Это займёт пару секунд.
        </div>

        {/* Обязательный канал */}
        <button
          type="button"
          onClick={() => openChannel(mainUrl)}
          style={{
            width: "100%", height: "54px", border: "none", borderRadius: "18px",
            background: "#F18726", color: "#FFFFFF", fontWeight: 600, fontSize: "16px",
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
          }}
        >
          Подписаться на канал
        </button>

        {/* Необязательный канал */}
        {optUrl && (
          <button
            type="button"
            onClick={() => openChannel(optUrl)}
            style={{
              width: "100%", height: "48px", border: "1px solid rgba(255,255,255,0.14)", borderRadius: "16px",
              background: "transparent", color: "#E3E3E3", fontWeight: 500, fontSize: "15px",
              cursor: "pointer",
            }}
          >
            Заметки BlinVPN (по желанию)
          </button>
        )}

        <button
          type="button"
          onClick={() => void recheck()}
          disabled={checking}
          style={{
            width: "100%", height: "50px", border: "none", borderRadius: "18px",
            background: "#2E2E2E", color: "#FFFFFF", fontWeight: 600, fontSize: "16px",
            cursor: checking ? "wait" : "pointer", opacity: checking ? 0.7 : 1, marginTop: "2px",
          }}
        >
          {checking ? "Проверяем…" : "Я подписался"}
        </button>

        {err && <div style={{ fontSize: "13px", color: "#FF6B6B", textAlign: "center" }}>{err}</div>}
      </div>
    </div>
  );
}
