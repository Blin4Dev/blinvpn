import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ListRow, PageHeader, Screen, SectionLabel, Surface, T } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { fetchConfig, fetchMe, isTelegram, type AppUser } from "../utils/api";
import { tgUser } from "../utils/telegram";

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
  const secondary = user?.telegram_id != null ? `ID ${user.telegram_id}` : (user?.email ? "Вход по e-mail" : "");

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
          subtitle="Связаться с оператором"
          onClick={() => window.open(supportUrl, "_blank", "noopener,noreferrer")}
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
    </Screen>
  );
}
