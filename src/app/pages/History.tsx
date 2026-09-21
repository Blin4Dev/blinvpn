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
          minHeight: "100vh",
          padding: "20px 20px 32px",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
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
          <div style={{ fontWeight: 700, fontSize: 26, color: "#FFFFFF" }}>История</div>
        </div>

        {loading && <p style={{ color: "#7D7D7D", fontSize: 15 }}>Загрузка…</p>}

        {/* Пустое состояние — по центру, с иконкой */}
        {!loading && items.length === 0 && (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              padding: "40px 20px",
              gap: 14,
            }}
          >
            <div
              style={{
                width: 72, height: 72, borderRadius: "50%", background: "#2E2E2E",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <MSIcon name="receipt_long" style={{ color: "#7D7D7D", fontSize: 34 }} />
            </div>
            <div style={{ fontWeight: 600, fontSize: 17, color: "#FFFFFF" }}>Пока нет операций</div>
            <div style={{ fontSize: 14, color: "#7D7D7D", maxWidth: 240, lineHeight: "20px" }}>
              Здесь появятся ваши платежи и операции по подписке.
            </div>
          </div>
        )}

        {/* Список */}
        {!loading && items.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map((item) => {
              const isInfo = item.payment_method === "promocode" || Number(item.amount) === 0;
              return (
                <div
                  key={item.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    background: "#2E2E2E",
                    borderRadius: 16,
                    padding: "14px 16px",
                  }}
                >
                  <span
                    style={{
                      flex: "0 0 auto",
                      width: 40, height: 40, borderRadius: "50%", background: "#3D3D3D",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <MSIcon
                      name={isInfo ? "info" : "payments"}
                      style={{ color: isInfo ? "#E3E3E3" : "#F18726", fontSize: 22 }}
                    />
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 16, color: "#FFFFFF", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {titleFor(item)}
                    </div>
                    <div style={{ fontWeight: 500, fontSize: 13, color: "#7D7D7D", marginTop: 2 }}>
                      {formatWhen(item.created_at)}
                    </div>
                  </div>
                  {item.amount != null && Number(item.amount) !== 0 && (
                    <div
                      style={{
                        flex: "0 0 auto",
                        fontWeight: 600,
                        fontSize: 15,
                        color: Number(item.amount) > 0 ? "#4ECB71" : "#FFFFFF",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {Number(item.amount) > 0 ? "+" : ""}{item.amount} ₽
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
