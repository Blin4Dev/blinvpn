import React, { useEffect, useState } from "react";
import { MSIcon } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { appFetch } from "../utils/api";

type HistoryItem = {
  id: number;
  amount?: number;
  status?: string;
  payment_method?: string;
  description?: string | null;
  created_at?: string;
};

function formatWhen(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function titleFor(item: HistoryItem): string {
  if (item.description) return String(item.description);
  const method = item.payment_method || "";
  if (method === "promocode") return `Промокод №${item.id}`;
  if (Number(item.amount) === 0) return `Операция №${item.id}`;
  return `Оплата №${item.id}`;
}

export default function History() {
  const goBack = useSmartBack("/");
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const data = await appFetch<{ items?: HistoryItem[] }>("/history");
        setItems(Array.isArray(data?.items) ? data.items : []);
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const phone: React.CSSProperties = {
    position: "relative",
    width: "402px",
    height: "803px",
    background: "#212121",
  };

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
      <div style={phone}>
        <button
          type="button"
          style={{
            position: "absolute",
            width: "37px",
            height: "37px",
            left: "26px",
            top: "36px",
            background: "#313131",
            borderRadius: "50%",
            border: "none",
            padding: 0,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={goBack}
          aria-label="Назад"
        >
          <MSIcon name="chevron_left" style={{ color: "#FFFFFF", fontSize: 24 }} />
        </button>

        <h1
          style={{
            position: "absolute",
            left: "73px",
            top: "38px",
            margin: 0,
            fontWeight: 600,
            fontSize: "27px",
            lineHeight: "33px",
            color: "#FFFFFF",
          }}
        >
          История
        </h1>

        <div
          style={{
            position: "absolute",
            left: "26px",
            right: "26px",
            top: "97px",
            bottom: "26px",
            overflowY: "auto",
          }}
        >
          {loading && (
            <p style={{ color: "#7D7D7D", fontSize: 15, marginTop: 24 }}>Загрузка…</p>
          )}
          {!loading && items.length === 0 && (
            <p style={{ color: "#7D7D7D", fontSize: 15, marginTop: 24 }}>Пока нет операций</p>
          )}
          {items.map((item, idx) => {
            const topGap = idx * 86;
            const isInfo = item.payment_method === "promocode" || Number(item.amount) === 0;
            return (
              <div key={item.id} style={{ position: "relative", height: 80, marginBottom: 6, marginTop: idx === 0 ? 0 : 0, top: 0 }}>
                <div
                  style={{
                    boxSizing: "border-box",
                    width: "350px",
                    height: "80px",
                    background: "#333333",
                    border: "1px solid #3D3D3D",
                    borderRadius: "10px",
                    position: "relative",
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      width: "37px",
                      height: "37px",
                      left: "21px",
                      top: "21px",
                      background: "#3D3D3D",
                      borderRadius: "50%",
                    }}
                  />
                  <MSIcon
                    name={isInfo ? "info" : "login"}
                    style={{
                      position: "absolute",
                      left: "27px",
                      top: "27px",
                      color: isInfo ? "#E3E3E3" : "#F18726",
                      transform: isInfo ? undefined : "rotate(-90deg)",
                      fontSize: 24,
                    }}
                  />
                  <p
                    style={{
                      position: "absolute",
                      left: "66px",
                      top: "19px",
                      margin: 0,
                      fontWeight: 600,
                      fontSize: "17px",
                      lineHeight: "21px",
                      color: "#FFFFFF",
                      maxWidth: "260px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {titleFor(item)}
                  </p>
                  <p
                    style={{
                      position: "absolute",
                      left: "66px",
                      top: "44px",
                      margin: 0,
                      fontWeight: 500,
                      fontSize: "13px",
                      lineHeight: "16px",
                      color: "#FFFFFF",
                      opacity: 0.53,
                    }}
                  >
                    {formatWhen(item.created_at)}
                    {item.amount != null && Number(item.amount) !== 0
                      ? ` · ${Number(item.amount) > 0 ? "+" : ""}${item.amount} ₽`
                      : ""}
                  </p>
                </div>
                {/* keep layout spacing stable */}
                <span style={{ display: "none" }}>{topGap}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
