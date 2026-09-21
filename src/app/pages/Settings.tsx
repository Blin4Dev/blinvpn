import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MSIcon, PageHeader, Screen, Surface, T, btnReset } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { fetchConfig, fetchMe, isTelegram, type AppUser } from "../utils/api";
import { tgUser } from "../utils/telegram";

function Row({
  icon,
  title,
  subtitle,
  onClick,
  last,
}: {
  icon: string;
  title: string;
  subtitle: string;
  onClick: () => void;
  last?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="blin-press"
      style={{
        ...btnReset,
        display: "flex",
        alignItems: "center",
        gap: 14,
        width: "100%",
        padding: "14px 16px",
        background: "transparent",
        border: "none",
        borderBottom: last ? "none" : `1px solid ${T.border}`,
        cursor: "pointer",
        textAlign: "left",
        color: T.text,
      }}
    >
      <span
        style={{
          flex: "0 0 auto",
          width: 44,
          height: 44,
          borderRadius: 14,
          background: T.orangeSoft,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <MSIcon name={icon} style={{ color: T.orange, fontSize: 22 }} />
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "block", fontWeight: 600, fontSize: 16, color: T.text }}>{title}</span>
        <span style={{ display: "block", fontWeight: 500, fontSize: 13, color: T.textMuted, marginTop: 2 }}>
          {subtitle}
        </span>
      </span>
      <MSIcon name="chevron_right" style={{ color: T.textDim, fontSize: 22, flex: "0 0 auto" }} />
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
  const tgName = [tg?.first_name, tg?.last_name].filter(Boolean).join(" ").trim();
  const primaryName = inTg
    ? (tgName || (user?.username ? `@${user.username}` : "Пользователь"))
    : (user?.email || (user?.username ? `@${user.username}` : "Пользователь"));
  const initial = (tgName || user?.username || user?.email || "B").trim().charAt(0).toUpperCase();
  const secondary = user?.telegram_id != null ? `ID: ${user.telegram_id}` : (user?.email ? "Вход по e-mail" : "");

  const caption: React.CSSProperties = {
    fontWeight: 600,
    fontSize: 12,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: T.textDim,
    margin: "20px 8px 8px",
  };

  return (
    <Screen>
      <PageHeader title="Настройки" onBack={goBack} />

      <Surface style={{ display: "flex", alignItems: "center", gap: 14, padding: 16 }}>
        <div
          style={{
            flex: "0 0 auto",
            width: 52,
            height: 52,
            borderRadius: "50%",
            overflow: "hidden",
            background: T.surfaceRaised,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: T.text,
            fontWeight: 700,
            fontSize: 20,
            border: `1px solid ${T.border}`,
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
          <div
            style={{
              fontWeight: 600,
              fontSize: 17,
              color: T.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {primaryName}
          </div>
          {secondary && (
            <div style={{ fontWeight: 500, fontSize: 13, color: T.textMuted, marginTop: 2 }}>{secondary}</div>
          )}
        </div>
      </Surface>

      <div style={caption}>Аккаунт</div>
      <Surface>
        <Row icon="shield" title="Безопасность" subtitle="Способы входа и привязки" onClick={() => navigate("/security")} />
        <Row icon="receipt_long" title="История платежей" subtitle="Платежи и транзакции" onClick={() => navigate("/history")} last />
      </Surface>

      <div style={caption}>Поддержка и документы</div>
      <Surface>
        <Row
          icon="support_agent"
          title="Поддержка"
          subtitle="Связаться с оператором"
          onClick={() => window.open(supportUrl, "_blank", "noopener,noreferrer")}
        />
        <Row icon="description" title="Договор оферты" subtitle="Юридическая информация" onClick={() => navigate("/legal/offer")} />
        <Row
          icon="policy"
          title="Политика конфиденциальности"
          subtitle="Обработка данных"
          onClick={() => navigate("/legal/privacy")}
          last
        />
      </Surface>
    </Screen>
  );
}
