import React, { useEffect, useState } from "react";
import { MSIcon, PageHeader, Screen, Surface, T } from "../components/ui";
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
    <Screen>
      <PageHeader title="История" onBack={goBack} />

      {loading && <p style={{ color: T.textMuted, fontSize: 15 }}>Загрузка…</p>}

      {!loading && items.length === 0 && (
        <div
          style={{
            flex: 1,
            minHeight: 360,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            gap: 14,
          }}
        >
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 24,
              background: T.surfaceRaised,
              border: `1px solid ${T.border}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <MSIcon name="receipt_long" style={{ color: T.textDim, fontSize: 34 }} />
          </div>
          <div style={{ fontWeight: 600, fontSize: 17, color: T.text }}>Пока нет операций</div>
          <div style={{ fontSize: 14, color: T.textMuted, maxWidth: 240, lineHeight: "20px" }}>
            Здесь появятся ваши платежи и операции по подписке.
          </div>
        </div>
      )}

      {!loading && items.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map((item) => {
            const isInfo = item.payment_method === "promocode" || Number(item.amount) === 0;
            return (
              <Surface
                key={item.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "14px 16px",
                  borderRadius: T.radius.md,
                }}
              >
                <span
                  style={{
                    flex: "0 0 auto",
                    width: 40,
                    height: 40,
                    borderRadius: 14,
                    background: isInfo ? T.surfaceRaised : T.orangeSoft,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <MSIcon
                    name={isInfo ? "info" : "payments"}
                    style={{ color: isInfo ? T.textMuted : T.orange, fontSize: 22 }}
                  />
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 15,
                      color: T.text,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {titleFor(item)}
                  </div>
                  <div style={{ fontWeight: 500, fontSize: 13, color: T.textMuted, marginTop: 2 }}>
                    {formatWhen(item.created_at)}
                  </div>
                </div>
                {item.amount != null && Number(item.amount) !== 0 && (
                  <div
                    style={{
                      flex: "0 0 auto",
                      fontWeight: 600,
                      fontSize: 15,
                      color: Number(item.amount) > 0 ? T.success : T.text,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {Number(item.amount) > 0 ? "+" : ""}
                    {item.amount} ₽
                  </div>
                )}
              </Surface>
            );
          })}
        </div>
      )}
    </Screen>
  );
}
