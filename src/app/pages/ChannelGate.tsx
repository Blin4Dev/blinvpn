import React, { useState } from "react";
import { fetchMembership, tgWebApp, type Membership } from "../utils/api";
import { Btn, MSIcon, T } from "../components/ui";

/**
 * Всплывающее окно «Подпишитесь на канал» поверх приложения.
 * Закрыть его нельзя — подписка обязательна, окно исчезает после проверки.
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

  const channelUrl = membership.channel_url || "https://t.me/blinvpn";

  const openChannel = () => {
    const wa = tgWebApp();
    if (wa?.openTelegramLink && /^https?:\/\/t\.me\//i.test(channelUrl)) wa.openTelegramLink(channelUrl);
    else if (wa?.openLink) wa.openLink(channelUrl);
    else window.open(channelUrl, "_blank", "noopener,noreferrer");
  };

  const recheck = async () => {
    if (checking) return;
    setChecking(true);
    setErr("");
    const m = await fetchMembership(true);
    setChecking(false);
    if (m.subscribed) onPassed();
    else setErr("Подписка пока не видна. Подпишитесь и нажмите ещё раз.");
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 3000,
        background: "rgba(8, 6, 4, 0.72)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        boxSizing: "border-box",
        fontFamily: T.font,
        animation: "blinvpnFadeIn 0.2s ease both",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 360,
          background: T.surface,
          border: `1px solid ${T.border}`,
          borderRadius: T.radius.xl,
          padding: "28px 22px 18px",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          animation: "blinvpnSheetUp 0.28s var(--ease-out) both",
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 18,
            background: T.orangeSoft,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 16,
          }}
        >
          <MSIcon name="campaign" style={{ color: T.orange, fontSize: 30 }} />
        </div>
        <div style={{ fontWeight: 600, fontSize: 20, color: T.text, letterSpacing: "-0.02em" }}>
          Подпишитесь на канал
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.5, color: T.textMuted, marginTop: 8, marginBottom: 20 }}>
          Чтобы пользоваться BlinVPN, подпишитесь на наш канал — там новости и статус серверов.
        </div>

        <Btn onClick={openChannel}>
          <MSIcon name="send" style={{ fontSize: 20, color: "inherit" }} />
          Подписаться
        </Btn>
        <Btn variant="ghost" disabled={checking} onClick={() => void recheck()} style={{ marginTop: 6 }}>
          {checking ? "Проверяем…" : "Я подписался — проверить"}
        </Btn>
        {err ? <div style={{ fontSize: 13, color: T.danger, marginTop: 6 }}>{err}</div> : null}
      </div>
    </div>
  );
}
