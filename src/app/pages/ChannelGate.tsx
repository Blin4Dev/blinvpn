import React, { useState } from "react";
import { fetchMembership, tgWebApp, type Membership } from "../utils/api";
import { Btn, BrandMark, T, pageFrame, pageOuter } from "../components/ui";

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
    else setErr("Подписка пока не видна. Подпишитесь и нажмите ещё раз.");
  };

  return (
    <div style={{ ...pageOuter({ alignItems: "center" }), position: "fixed", inset: 0, zIndex: 2000, padding: 26 }}>
      <div style={{ ...pageFrame({ height: "auto", minHeight: 0, overflow: "visible", width: "100%", maxWidth: 360, background: "transparent" }) }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <BrandMark size="sm" />
          <div style={{ fontWeight: 600, fontSize: 22, color: T.text, letterSpacing: "-0.02em", marginTop: 12 }}>
            Подписка на канал
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.5, color: T.textMuted }}>
            Чтобы пользоваться BlinVPN, подпишитесь на основной канал — это займёт пару секунд.
          </div>

          <Btn onClick={() => openChannel(mainUrl)} style={{ marginTop: 8 }}>
            Подписаться на канал
          </Btn>
          {optUrl ? (
            <Btn variant="secondary" onClick={() => openChannel(optUrl)}>
              Дополнительный канал
            </Btn>
          ) : null}
          <Btn variant="ghost" disabled={checking} onClick={() => void recheck()}>
            {checking ? "Проверяем…" : "Я подписался — проверить"}
          </Btn>
          {err ? <div style={{ fontSize: 13, color: T.danger }}>{err}</div> : null}
        </div>
      </div>
    </div>
  );
}
