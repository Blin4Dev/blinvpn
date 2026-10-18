import React from "react";
import { T } from "./ui";
import { formatBytesRu, type TrafficInfo } from "../utils/api";

const RESET_TEXT: Record<string, string> = {
  DAY: "Счётчик обнуляется каждый день",
  WEEK: "Счётчик обнуляется каждую неделю",
  MONTH: "Счётчик обнуляется каждый месяц",
};

// used traffic: «12,4 ГБ из 200 ГБ» + bar
export default function TrafficCard({ t }: { t: TrafficInfo }) {
  if (!t.available || t.used_bytes == null) return null;
  const used = Math.max(0, t.used_bytes);
  const limit = t.limit_bytes || 0;
  const pct = limit > 0 ? Math.min(100, (100 * used) / limit) : 0;
  const color = pct >= 90 ? "#ff6b6b" : T.orange;
  const note = RESET_TEXT[String(t.strategy || "")];
  return (
    <div
      style={{
        background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius.lg,
        padding: "14px 16px", marginBottom: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <span style={{ fontSize: 14, color: T.textMuted }}>Потрачено</span>
        <span style={{ fontSize: 16, fontWeight: 600, color: T.text }}>
          {formatBytesRu(used)}
          <span style={{ color: T.textMuted, fontWeight: 500 }}>
            {limit > 0 ? ` из ${formatBytesRu(limit)}` : " · без ограничений"}
          </span>
        </span>
      </div>
      {limit > 0 && (
        <div style={{ marginTop: 10, height: 6, borderRadius: 3, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
          <div style={{ width: `${Math.max(pct, used > 0 ? 2 : 0)}%`, height: "100%", borderRadius: 3, background: color }} />
        </div>
      )}
      {limit > 0 && (
        <div style={{ marginTop: 8, fontSize: 12, color: pct >= 90 ? color : T.textMuted }}>
          {pct >= 100 ? "Трафик закончился" : `Осталось ${formatBytesRu(Math.max(0, limit - used))}`}
          {note ? ` · ${note.toLowerCase()}` : ""}
        </div>
      )}
      {limit === 0 && note ? <div style={{ marginTop: 6, fontSize: 12, color: T.textMuted }}>{note}</div> : null}
    </div>
  );
}
