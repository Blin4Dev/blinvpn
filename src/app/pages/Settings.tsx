import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ListRow, PageHeader, Screen, SectionLabel, Surface, T, btnReset } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { fetchMe, isTelegram, openTgLink, type AppUser } from "../utils/api";

const APP_VERSION = "3.0.0";
const APP_NEWS_URL = "https://t.me/blinnotes";
import { tgUser } from "../utils/telegram";

export default function Settings() {
  const navigate = useNavigate();
  const goBack = useSmartBack("/");
  const [user, setUser] = useState<AppUser | null>(null);

  useEffect(() => {
    void (async () => {
      const u = await fetchMe();
      setUser(u);
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
  // Внутренний номер аккаунта (его называют в поддержке), а не Telegram ID.
  const secondary = user?.id != null ? `ID ${user.id}` : "";

  return (
    <Screen>
      <PageHeader title="Настройки" onBack={goBack} />

      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 8 }}>
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: "50%",
            overflow: "hidden",
            background: T.surface,
            border: `1px solid ${T.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: T.text,
            fontWeight: 600,
            fontSize: 18,
            flexShrink: 0,
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
              fontSize: 16,
              color: T.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {primaryName}
          </div>
          {secondary ? (
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 2 }}>{secondary}</div>
          ) : null}
        </div>
      </div>

      <SectionLabel>Аккаунт</SectionLabel>
      <Surface padded>
        <ListRow
          icon="shield"
          title="Безопасность"
          subtitle="Способы входа и привязки"
          onClick={() => navigate("/security")}
        />
        <ListRow
          icon="receipt_long"
          title="История платежей"
          subtitle="Платежи и операции"
          onClick={() => navigate("/history")}
          last
        />
      </Surface>

      <SectionLabel>Поддержка</SectionLabel>
      <Surface padded>
        <ListRow
          icon="support_agent"
          title="Поддержка"
          subtitle="Чат с поддержкой"
          onClick={() => navigate("/support")}
        />
        <ListRow
          icon="description"
          title="Договор оферты"
          onClick={() => navigate("/legal/offer")}
        />
        <ListRow
          icon="policy"
          title="Политика конфиденциальности"
          onClick={() => navigate("/legal/privacy")}
          last
        />
      </Surface>

      {/* версия приложения — ведёт в канал с новостями */}
      <button
        type="button"
        onClick={() => openTgLink(APP_NEWS_URL)}
        style={{ ...btnReset, alignSelf: "center", marginTop: 20, padding: "6px 12px", background: "transparent",
          border: "none", color: T.textDim, fontSize: 13, fontWeight: 500, cursor: "pointer" }}
      >
        v{APP_VERSION}
      </button>
    </Screen>
  );
}
