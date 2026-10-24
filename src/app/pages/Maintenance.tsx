import React from "react";
import { MSIcon, T, pageFrame, pageOuter } from "../components/ui";
import { PrimaryButton, haptic } from "../components/onbUi";
import { channelUrl } from "../utils/maintenance";

type TgWebApp = { openTelegramLink?: (u: string) => void; openLink?: (u: string) => void };

function openChannel() {
  const url = channelUrl();
  haptic()?.impactOccurred?.("light");
  let wa: TgWebApp | undefined;
  try {
    wa = (window as unknown as { Telegram?: { WebApp?: TgWebApp } }).Telegram?.WebApp;
  } catch {
    wa = undefined;
  }
  if (wa?.openTelegramLink && /^https?:\/\/t\.me\//i.test(url)) wa.openTelegramLink(url);
  else if (wa?.openLink) wa.openLink(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

// страница техработ: единственное, что видно, пока режим включён или панель не отвечает. Закрыть нельзя —
// App сам вернёт приложение, когда статус станет нормальным.
export default function Maintenance() {
  return (
    <div style={pageOuter()}>
      <div
        className="blin-onb-enter-slide"
        style={{
          ...pageFrame(),
          display: "flex",
          flexDirection: "column",
          minHeight: "100%",
          // поля как у Screen во всём мини-аппе
          paddingTop: 24,
          paddingLeft: 26,
          paddingRight: 26,
          paddingBottom: "calc(28px + var(--blin-tg-pad-bottom, 0px) / var(--blin-scale, 1))",
        }}
      >
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
          <div className="blin-onb-item" style={{ ["--i" as string]: 0, marginBottom: 24 }}>
            <MSIcon name="construction" style={{ fontSize: 56, color: T.orange }} />
          </div>
          <div className="blin-onb-item" style={{ ["--i" as string]: 1, fontWeight: 700, fontSize: 28, letterSpacing: "-0.02em", color: T.text }}>
            Технические работы
          </div>
          <div className="blin-onb-item" style={{ ["--i" as string]: 2, fontSize: 16, lineHeight: 1.45, color: T.textMuted, marginTop: 10 }}>
            Сервисы могут работать нестабильно
          </div>
        </div>

        <PrimaryButton i={3} onClick={openChannel}>
          Перейти в канал
        </PrimaryButton>
      </div>
    </div>
  );
}
