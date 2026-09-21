import React, { useEffect, useRef } from "react";
import type { TelegramOAuthPayload } from "../utils/api";

declare global {
  interface Window {
    __blinTgAuth?: (user: TelegramOAuthPayload) => void;
  }
}

type Props = {
  botUsername: string;
  onAuth: (user: TelegramOAuthPayload) => void;
  cornerRadius?: number;
  size?: "large" | "medium" | "small";
};

/**
 * Официальный Telegram Login Widget (не кастомная кнопка).
 * Требует botUsername без @ и домен, добавленный в BotFather → Domain.
 */
export function TelegramLoginWidget({
  botUsername,
  onAuth,
  cornerRadius = 12,
  size = "large",
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onAuthRef = useRef(onAuth);
  onAuthRef.current = onAuth;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !botUsername) return;

    const cbName = `__blinTgAuth_${Math.random().toString(36).slice(2, 9)}`;
    (window as unknown as Record<string, (u: TelegramOAuthPayload) => void>)[cbName] = (user) => {
      onAuthRef.current(user);
    };

    host.innerHTML = "";
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.async = true;
    script.setAttribute("data-telegram-login", botUsername.replace(/^@/, ""));
    script.setAttribute("data-size", size);
    script.setAttribute("data-radius", String(cornerRadius));
    script.setAttribute("data-request-access", "write");
    script.setAttribute("data-onauth", `${cbName}(user)`);
    host.appendChild(script);

    return () => {
      delete (window as unknown as Record<string, unknown>)[cbName];
      host.innerHTML = "";
    };
  }, [botUsername, cornerRadius, size]);

  if (!botUsername) return null;

  return (
    <div
      ref={hostRef}
      style={{
        display: "flex",
        justifyContent: "center",
        minHeight: 40,
        width: "100%",
      }}
    />
  );
}
