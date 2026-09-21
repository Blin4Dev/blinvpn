import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MSIcon } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { fetchConfig, fetchMe, isTelegram, type AppUser } from "../utils/api";
import { tgUser } from "../utils/telegram";

type RowProps = {
  icon: string;
  title: string;
  subtitle: string;
  onClick: () => void;
  last?: boolean;
};

function Row({ icon, title, subtitle, onClick, last }: RowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        width: "100%",
        padding: "14px 16px",
        background: "transparent",
        border: "none",
        borderBottom: last ? "none" : "1px solid rgba(255,255,255,0.06)",
        cursor: "pointer",
        textAlign: "left",
        color: "#FFFFFF",
      }}
    >
      <span
        style={{
          flex: "0 0 auto",
          width: 44,
          height: 44,
          borderRadius: 12,
          background: "#484848",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <MSIcon name={icon} style={{ color: "#E3E3E3", fontSize: 24, opacity: 0.7 }} />
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "block", fontWeight: 600, fontSize: 16, color: "#FFFFFF" }}>{title}</span>
        <span style={{ display: "block", fontWeight: 500, fontSize: 13, color: "#7D7D7D", marginTop: 2 }}>{subtitle}</span>
      </span>
      <MSIcon name="chevron_right" style={{ color: "#5A5A5A", fontSize: 22, flex: "0 0 auto" }} />
    </button>
  );
}

export default function Settings() {
  const navigate = useNavigate();
  const goBack = useSmartBack("/");
  const [user, setUser] = useState<AppUser | null>(null);
  const [supportUrl, setSupportUrl] = useState("https://t.me/blinteams");

  useEffect(() => {
    void (async () => {
      const u = await fetchMe();
      setUser(u);
      try {
        const conf = await fetchConfig();
        if (conf && typeof conf.supportUrl === "string" && conf.supportUrl) {
          setSupportUrl(conf.supportUrl as string);
        }
      } catch { /* дефолт */ }
    })();
  }, []);

  const tg = tgUser();
  const inTg = isTelegram();
  const avatarUrl = tg?.photo_url || "";

  // Имя: вход через Telegram → отображаемое имя (или @ник); вход через почту → e-mail.
  const tgName = [tg?.first_name, tg?.last_name].filter(Boolean).join(" ").trim();
  const primaryName = inTg
    ? (tgName || (user?.username ? `@${user.username}` : "Пользователь"))
    : (user?.email || (user?.username ? `@${user.username}` : "Пользователь"));
  const initial = (tgName || user?.username || user?.email || "B").trim().charAt(0).toUpperCase();
  const secondary = user?.telegram_id != null ? `ID: ${user.telegram_id}` : (user?.email ? "Вход по e-mail" : "");

  const cardStyle: React.CSSProperties = {
    background: "#2E2E2E",
    borderRadius: 24,
    overflow: "hidden",
  };
  const captionStyle: React.CSSProperties = {
    fontWeight: 600,
    fontSize: 13,
    color: "#7D7D7D",
    margin: "18px 8px 8px",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#212121",
        fontFamily: "'Inter', sans-serif",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 402,
          padding: "20px 20px 32px",
          boxSizing: "border-box",
        }}
      >
        {/* Шапка */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
          <button
            type="button"
            onClick={goBack}
            aria-label="Назад"
            style={{
              flex: "0 0 auto",
              width: 40, height: 40, borderRadius: "50%",
              background: "#313131", border: "none", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <MSIcon name="chevron_left" style={{ color: "#FFFFFF", fontSize: 24 }} />
          </button>
          <div style={{ fontWeight: 700, fontSize: 26, color: "#FFFFFF" }}>Настройки</div>
        </div>

        {/* Профиль */}
        <div style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 14, padding: 16 }}>
          <div
            style={{
              flex: "0 0 auto",
              width: 48, height: 48, borderRadius: "50%", overflow: "hidden",
              background: "#484848", display: "flex", alignItems: "center", justifyContent: "center",
              color: "#FFFFFF", fontWeight: 700, fontSize: 20,
            }}
          >
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
                onError={(e) => { e.currentTarget.style.display = "none"; }}
              />
            ) : (
              initial
            )}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 17, color: "#FFFFFF", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {primaryName}
            </div>
            {secondary && (
              <div style={{ fontWeight: 500, fontSize: 13, color: "#7D7D7D", marginTop: 2 }}>{secondary}</div>
            )}
          </div>
        </div>

        {/* Аккаунт */}
        <div style={captionStyle}>Аккаунт</div>
        <div style={cardStyle}>
          <Row icon="shield" title="Безопасность" subtitle="Способы входа и привязки" onClick={() => navigate("/security")} />
          <Row icon="receipt_long" title="История платежей" subtitle="Платежи и транзакции" onClick={() => navigate("/history")} last />
        </div>

        {/* Поддержка и документы */}
        <div style={captionStyle}>Поддержка и документы</div>
        <div style={cardStyle}>
          <Row icon="support_agent" title="Поддержка" subtitle="Связаться с оператором" onClick={() => window.open(supportUrl, "_blank", "noopener,noreferrer")} />
          <Row icon="description" title="Договор оферты" subtitle="Юридическая информация" onClick={() => navigate("/legal/offer")} />
          <Row icon="policy" title="Политика конфиденциальности" subtitle="Обработка данных" onClick={() => navigate("/legal/privacy")} last />
        </div>
      </div>
    </div>
  );
}
