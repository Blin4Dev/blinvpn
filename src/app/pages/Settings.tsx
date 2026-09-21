import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BackCircleButton, MSIcon } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { fetchConfig, fetchMe, type AppUser } from "../utils/api";

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

  const displayName = user?.username
    ? `BlinVPN @${user.username}`
    : "BlinVPN @blinvpn_bot";
  const displayId = user?.telegram_id != null ? `ID: ${user.telegram_id}` : "ID: —";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "100vh",
        background: "#111",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <div
        style={{
          position: "relative",
          width: "402px",
          height: "803px",
          background: "#212121",
          overflow: "hidden",
        }}
      >
        {/* Заголовок */}
        <div
          style={{
            position: "absolute",
            width: "159px",
            height: "33px",
            left: "73px",
            top: "28px",
            fontWeight: 600,
            fontSize: "27px",
            lineHeight: "33px",
            display: "flex",
            alignItems: "center",
            color: "#FFFFFF",
          }}
        >
          Настройки
        </div>

        {/* Кнопка назад (Ellipse 1 + chevron) */}
        <BackCircleButton onClick={goBack} />

        {/* Group 20 — верхний блок с логином */}
        <div
          style={{
            position: "absolute",
            width: "330px",
            height: "68px",
            left: "36px",
            top: "83px",
            background: "#3D3D3D",
            borderRadius: "30px",
          }}
        />

        <div
          style={{
            position: "absolute",
            width: "32px",
            height: "32px",
            left: "48px",
            top: "101px",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              background: "#E3E3E3",
            }}
          />
        </div>

        <div
          style={{
            position: "absolute",
            width: "220px",
            height: "21px",
            left: "90px",
            top: "97px",
            fontWeight: 600,
            fontSize: "17px",
            lineHeight: "21px",
            display: "flex",
            alignItems: "center",
            color: "#FFFFFF",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {displayName}
        </div>

        <div
          style={{
            position: "absolute",
            width: "189px",
            height: "16px",
            left: "90px",
            top: "121px",
            fontWeight: 600,
            fontSize: "13px",
            lineHeight: "16px",
            display: "flex",
            alignItems: "center",
            color: "#7D7D7D",
          }}
        >
          {displayId}
        </div>

        {/* Group 41 — Аккаунт: Безопасность + История платежей */}
        <div
          style={{
            position: "absolute",
            width: "330px",
            height: "190px",
            left: "35px",
            top: "166px",
            background: "#3D3D3D",
            borderRadius: "30px",
          }}
        />

        <div
          style={{
            position: "absolute",
            width: "63px",
            height: "16px",
            left: "57px",
            top: "180px",
            fontWeight: 600,
            fontSize: "13px",
            lineHeight: "16px",
            display: "flex",
            alignItems: "center",
            color: "#7D7D7D",
            pointerEvents: "none",
          }}
        >
          Аккаунт
        </div>

        {/* Безопасность (строка 1) */}
        <button
          type="button"
          onClick={() => navigate("/security")}
          style={{
            position: "absolute",
            width: "330px",
            height: "100px",
            left: "35px",
            top: "166px",
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
        />
        <div
          style={{
            position: "absolute",
            width: "48px",
            height: "48px",
            left: "57px",
            top: "206px",
            background: "#484848",
            borderRadius: "12px",
            pointerEvents: "none",
          }}
        />
        <MSIcon
          name="shield"
          style={{
            position: "absolute",
            width: "32px",
            height: "32px",
            left: "65px",
            top: "214px",
            opacity: 0.5,
            color: "#E3E3E3",
            fontSize: 26,
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "absolute",
            width: "108px",
            height: "21px",
            left: "113px",
            top: "211px",
            fontWeight: 600,
            fontSize: "17px",
            lineHeight: "21px",
            display: "flex",
            alignItems: "center",
            color: "#FFFFFF",
            pointerEvents: "none",
          }}
        >
          Безопасность
        </div>
        <div
          style={{
            position: "absolute",
            width: "260px",
            height: "16px",
            left: "113px",
            top: "233px",
            fontWeight: 500,
            fontSize: "13px",
            lineHeight: "16px",
            display: "flex",
            alignItems: "center",
            color: "#7D7D7D",
            pointerEvents: "none",
          }}
        >
          Способы входа и привязки
        </div>

        {/* Разделитель */}
        <div
          style={{
            position: "absolute",
            width: "286px",
            height: "1px",
            left: "57px",
            top: "266px",
            background: "rgba(255,255,255,0.06)",
            pointerEvents: "none",
          }}
        />

        {/* История платежей (строка 2) */}
        <button
          type="button"
          onClick={() => navigate("/history")}
          style={{
            position: "absolute",
            width: "330px",
            height: "90px",
            left: "35px",
            top: "266px",
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
        />
        <div
          style={{
            position: "absolute",
            width: "48px",
            height: "48px",
            left: "57px",
            top: "296px",
            background: "#484848",
            borderRadius: "12px",
            pointerEvents: "none",
          }}
        />
        <MSIcon
          name="receipt_long"
          style={{
            position: "absolute",
            width: "32px",
            height: "32px",
            left: "65px",
            top: "304px",
            opacity: 0.5,
            color: "#E3E3E3",
            fontSize: 26,
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "absolute",
            width: "200px",
            height: "21px",
            left: "113px",
            top: "301px",
            fontWeight: 600,
            fontSize: "17px",
            lineHeight: "21px",
            display: "flex",
            alignItems: "center",
            color: "#FFFFFF",
            pointerEvents: "none",
          }}
        >
          История платежей
        </div>
        <div
          style={{
            position: "absolute",
            width: "200px",
            height: "16px",
            left: "113px",
            top: "323px",
            fontWeight: 500,
            fontSize: "13px",
            lineHeight: "16px",
            display: "flex",
            alignItems: "center",
            color: "#7D7D7D",
            pointerEvents: "none",
          }}
        >
          Платежи и транзакции
        </div>

        {/* Group 42 — Поддержка и бумажки */}
        <div
          style={{
            position: "absolute",
            width: "330px",
            height: "223px",
            left: "35px",
            top: "366px",
            background: "#3D3D3D",
            borderRadius: "30px",
          }}
        />

        <div
          style={{
            position: "absolute",
            width: "150px",
            height: "16px",
            left: "57px",
            top: "380px",
            fontWeight: 600,
            fontSize: "13px",
            lineHeight: "16px",
            display: "flex",
            alignItems: "center",
            color: "#7D7D7D",
          }}
        >
          Поддержка и бумажки
        </div>

        {/* Поддержка */}
        <button
          type="button"
          onClick={() => window.open(supportUrl, "_blank", "noopener,noreferrer")}
          style={{
            position: "absolute",
            width: "48px",
            height: "48px",
            left: "57px",
            top: "406px",
            background: "#484848",
            borderRadius: "12px",
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
        />
        <MSIcon
          name="support_agent"
          style={{
            position: "absolute",
            width: "32px",
            height: "32px",
            left: "65px",
            top: "414px",
            opacity: 0.5,
            color: "#FFFFFF",
            fontSize: 26,
          }}
        />

        <div
          style={{
            position: "absolute",
            width: "104px",
            height: "21px",
            left: "113px",
            top: "411px",
            fontWeight: 600,
            fontSize: "17px",
            lineHeight: "21px",
            display: "flex",
            alignItems: "center",
            color: "#FFFFFF",
          }}
        >
          Поддержка
        </div>
        <div
          style={{
            position: "absolute",
            width: "166px",
            height: "16px",
            left: "113px",
            top: "433px",
            fontWeight: 500,
            fontSize: "13px",
            lineHeight: "16px",
            display: "flex",
            alignItems: "center",
            color: "#7D7D7D",
          }}
        >
          Связаться с оператором
        </div>

        {/* Договор оферты */}
        <button
          type="button"
          style={{
            position: "absolute",
            width: "48px",
            height: "48px",
            left: "57px",
            top: "462px",
            background: "#484848",
            borderRadius: "12px",
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
          onClick={() => navigate("/legal/offer")}
        />
        <MSIcon
          name="description"
          style={{
            position: "absolute",
            width: "32px",
            height: "32px",
            left: "65px",
            top: "470px",
            opacity: 0.5,
            color: "#E3E3E3",
            fontSize: 26,
          }}
        />

        <div
          style={{
            position: "absolute",
            width: "145px",
            height: "21px",
            left: "113px",
            top: "467px",
            fontWeight: 600,
            fontSize: "17px",
            lineHeight: "21px",
            display: "flex",
            alignItems: "center",
            color: "#FFFFFF",
          }}
        >
          Договор оферты
        </div>
        <div
          style={{
            position: "absolute",
            width: "166px",
            height: "16px",
            left: "113px",
            top: "489px",
            fontWeight: 500,
            fontSize: "13px",
            lineHeight: "16px",
            display: "flex",
            alignItems: "center",
            color: "#7D7D7D",
          }}
        >
          Юридическая бумажка
        </div>

        {/* Политика конфиденциальности */}
        <button
          type="button"
          style={{
            position: "absolute",
            width: "48px",
            height: "48px",
            left: "57px",
            top: "518px",
            background: "#484848",
            borderRadius: "12px",
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
          onClick={() => navigate("/legal/privacy")}
        />
        <MSIcon
          name="policy"
          style={{
            position: "absolute",
            width: "32px",
            height: "32px",
            left: "65px",
            top: "526px",
            opacity: 0.5,
            color: "#E3E3E3",
            fontSize: 26,
          }}
        />

        <div
          style={{
            position: "absolute",
            width: "245px",
            height: "42px",
            left: "113px",
            top: "521px",
            fontWeight: 600,
            fontSize: "17px",
            lineHeight: "21px",
            display: "flex",
            alignItems: "center",
            color: "#FFFFFF",
          }}
        >
          Политика конфиденциальности
        </div>

              </div>
    </div>
  );
}
