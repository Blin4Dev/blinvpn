import React, { useState } from "react";
import { fetchMembership, tgWebApp, type Membership } from "../utils/api";
import { Btn, BrandMark, MSIcon, T, pageFrame, pageOuter } from "../components/ui";

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
    else setErr("Мы пока не видим подписку. Подпишитесь и нажмите ещё раз.");
  };

  return (
    <div style={{ ...pageOuter({ alignItems: "center" }), position: "fixed", inset: 0, zIndex: 2000, padding: 24 }}>
      <div style={{ ...pageFrame({ height: "auto", minHeight: 0, overflow: "visible", width: "100%", maxWidth: 360, background: "transparent" }) }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, textAlign: "center" }}>
          <BrandMark size="lg" />
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 24,
              background: T.orangeSoft,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginTop: 8,
            }}
          >
            <MSIcon name="campaign" style={{ color: T.orange, fontSize: 36 }} />
          </div>
          <div style={{ fontWeight: 700, fontSize: 24, color: T.text, letterSpacing: "-0.03em" }}>
            Подпишитесь на канал
          </div>
          <div style={{ fontSize: 14, lineHeight: "21px", color: T.textMuted }}>
            Чтобы пользоваться BlinVPN, подпишитесь на основной канал — это займёт пару секунд.
          </div>

          <Btn onClick={() => openChannel(mainUrl)} style={{ marginTop: 6 }}>
            <MSIcon name="open_in_new" style={{ fontSize: 22 }} />
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

          {err ? (
            <div style={{ fontSize: 13, color: T.danger, lineHeight: "18px" }}>{err}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
