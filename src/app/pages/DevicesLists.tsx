import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Btn, MSIcon, PageHeader, Screen, T, btnReset } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { appFetch, revokeDevice } from "../utils/api";

type Device = { id?: string | number; name?: string; last_seen?: string; lastSeen?: string };

export default function DevicesLists() {
  const navigate = useNavigate();
  const goBack = useSmartBack("/subscription");
  const [devices, setDevices] = useState<Device[]>([]);
  const [limit, setLimit] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await appFetch<{ devices?: Device[]; used?: number; limit?: number }>("/devices");
      setDevices(Array.isArray(data?.devices) ? data.devices : []);
      if (data?.limit != null) setLimit(Number(data.limit));
    } catch {
      setDevices([]);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const handleRemove = async (id: string) => {
    if (!id || removing) return;
    if (!window.confirm("Отвязать это устройство?")) return;
    setRemoving(id);
    const ok = await revokeDevice(id);
    setRemoving(null);
    if (ok) void load();
  };

  return (
    <Screen>
      <PageHeader
        title="Устройства"
        onBack={goBack}
        right={
          limit != null ? (
            <span style={{ fontSize: 14, color: T.textMuted, fontWeight: 500 }}>
              {devices.length} / {limit}
            </span>
          ) : null
        }
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {loading && <p style={{ color: T.textMuted, fontSize: 15, margin: 0 }}>Загрузка…</p>}
        {!loading && devices.length === 0 && (
          <p style={{ color: T.textMuted, fontSize: 15, lineHeight: 1.4, margin: 0 }}>
            Пока нет активных устройств.
            <br />
            Они появятся после подключения к VPN.
          </p>
        )}
        {devices.map((d, idx) => {
          const id = String(d.id ?? "");
          const name = d.name || `Устройство ${idx + 1}`;
          const last = d.last_seen || d.lastSeen || "онлайн: нет данных";
          return (
            <div
              key={String(d.id ?? idx)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                minHeight: 64,
                padding: "10px 12px 10px 18px",
                background: T.surface,
                border: `1px solid ${T.border}`,
                borderRadius: T.radius.lg,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 500,
                    fontSize: 16,
                    color: T.text,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {name}
                </div>
                <div style={{ fontSize: 13, color: T.textMuted, marginTop: 2 }}>{last}</div>
              </div>
              <button
                type="button"
                onClick={() => void handleRemove(id)}
                disabled={removing === id}
                aria-label="Отвязать устройство"
                className="blin-press"
                style={{
                  ...btnReset,
                  width: 36,
                  height: 36,
                  flexShrink: 0,
                  borderRadius: "50%",
                  border: "none",
                  background: T.dangerSoft,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: removing === id ? 0.5 : 1,
                }}
              >
                <MSIcon name="close" style={{ color: T.danger, fontSize: 20 }} />
              </button>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: "auto", paddingTop: 24 }}>
        <Btn variant="secondary" onClick={() => navigate("/subscription/increase")}>
          <MSIcon name="add" style={{ fontSize: 22, color: "inherit" }} />
          Докупить устройство
        </Btn>
      </div>
    </Screen>
  );
}
