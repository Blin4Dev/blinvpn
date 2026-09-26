import React, { useState } from "react";
import { Btn, MSIcon, T } from "./ui";

/** Копирование с запасным путём для WebView, где navigator.clipboard недоступен. */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fallback ниже */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Ссылка на подписку + кнопка «Скопировать». Без установки приложений и deep-link. */
export default function SubLinkBox({
  link,
  loading,
  error,
}: {
  link: string;
  loading?: boolean;
  error?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    if (await copyText(link)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        onClick={() => void onCopy()}
        style={{
          background: T.surface,
          border: `1px solid ${T.border}`,
          borderRadius: T.radius.md,
          padding: "14px 16px",
          fontSize: 14,
          lineHeight: 1.45,
          color: loading || error ? T.textMuted : T.text,
          wordBreak: "break-all",
          userSelect: "all",
          WebkitUserSelect: "all",
          cursor: link ? "pointer" : "default",
          minHeight: 52,
        }}
      >
        {loading ? "Получаем ссылку…" : error ? <span style={{ color: T.danger }}>{error}</span> : link}
      </div>
      <Btn disabled={!link || loading} onClick={() => void onCopy()}>
        <MSIcon name={copied ? "check" : "content_copy"} style={{ fontSize: 20, color: "inherit" }} />
        {copied ? "Скопировано" : "Скопировать ссылку"}
      </Btn>
    </div>
  );
}
