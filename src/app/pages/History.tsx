import React, { useEffect, useState } from "react";
import { PageHeader, Screen, Surface, T } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { appFetch } from "../utils/api";

type HistoryItem = {
  id: number | string;
  title?: string;
  method?: string;
  amount?: number;
  stars?: number | null;
  direction?: "in" | "out";
  status?: string;
  payment_method?: string;
  description?: string | null;
  created_at?: string;
};

function fmtAmount(v: number): string {
  return v.toLocaleString("ru-RU", { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
}

function formatWhen(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function titleFor(item: HistoryItem): string {
  if (item.title) return item.title;
  const method = item.payment_method || "";
  if (method === "referral") return "Бонус за друга";
  if (item.description) return String(item.description);
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

      {loading && <p style={{ color: T.textMuted, fontSize: 14 }}>Загрузка…</p>}

      {!loading && items.length === 0 && (
        <div style={{ paddingTop: 48 }}>
          <div style={{ fontWeight: 500, fontSize: 15, color: T.text }}>Операций пока нет</div>
          <div style={{ fontSize: 14, color: T.textMuted, marginTop: 6, lineHeight: 1.45, maxWidth: 280 }}>
            Здесь появятся платежи и операции по подписке.
          </div>
        </div>
      )}

      {!loading && items.length > 0 && (
        <Surface padded>
          {items.map((item, i) => {
            const last = i === items.length - 1;
            return (
              <div
                key={item.id}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 12,
                  padding: "14px 0",
                  borderBottom: last ? "none" : `1px solid ${T.border}`,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontWeight: 500,
                      fontSize: 15,
                      color: T.text,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {titleFor(item)}
                  </div>
                  <div style={{ fontSize: 13, color: T.textMuted, marginTop: 3 }}>
                    {formatWhen(item.created_at)}
                    {item.method ? ` · ${item.method}` : ""}
                    {item.status === "refunded" ? " · деньги возвращены" : ""}
                  </div>
                </div>
                {item.amount != null && Number(item.amount) !== 0 && (() => {
                  const out = item.direction ? item.direction === "out" : Number(item.amount) < 0;
                  const refunded = item.status === "refunded";
                  const value = Math.abs(Number(item.amount));
                  return (
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: 15,
                        color: refunded ? T.textMuted : out ? T.text : T.orange,
                        textDecoration: refunded ? "line-through" : "none",
                        whiteSpace: "nowrap",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {item.stars ? `${out ? "−" : "+"}${item.stars} ⭐` : `${out ? "−" : "+"}${fmtAmount(value)} ₽`}
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </Surface>
      )}
    </Screen>
  );
}
