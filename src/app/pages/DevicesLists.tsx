import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BackCircleButton, MSIcon } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { appFetch, revokeDevice } from "../utils/api";

function PlusOutline24() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 5v14M5 12h14" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}

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
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "100vh",
        background: "#14110E",
        fontFamily: "'Outfit', system-ui, sans-serif",
      }}
    >
      <div
        style={{
          position: "relative",
          width: "402px",
          height: "803px",
          background: "#14110E",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            width: "166px",
            height: "33px",
            left: "73px",
            top: "28px",
            fontFamily: "'Outfit', system-ui, sans-serif",
            fontWeight: 600,
            fontSize: "27px",
            lineHeight: "33px",
            display: "flex",
            alignItems: "center",
            color: "#FFFFFF",
          }}
        >
          Устройства
        </div>

        <BackCircleButton onClick={goBack} />

        {limit != null && (
          <div
            style={{
              position: "absolute",
              left: "26px",
              top: "68px",
              fontSize: 13,
              color: "#A89B8C",
            }}
          >
            {devices.length} / {limit}
          </div>
        )}

        <div
          style={{
            position: "absolute",
            left: "26px",
            right: "26px",
            top: "87px",
            bottom: "100px",
            overflowY: "auto",
          }}
        >
          {loading && <p style={{ color: "#A89B8C", fontSize: 15 }}>Загрузка…</p>}
          {!loading && devices.length === 0 && (
            <p style={{ color: "#A89B8C", fontSize: 15, lineHeight: 1.4 }}>
              Пока нет активных устройств.
              <br />
              Они появятся после подключения к VPN.
            </p>
          )}
          {devices.map((d, idx) => {
            const name = d.name || `Устройство ${idx + 1}`;
            const last = d.last_seen || d.lastSeen || "онлайн: нет данных";
            return (
              <div
                key={String(d.id ?? idx)}
                style={{
                  position: "relative",
                  width: "350px",
                  height: "68px",
                  background: "#2A241E",
                  borderRadius: "30px",
                  marginBottom: "7px",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: "27px",
                    top: "14px",
                    fontWeight: 500,
                    fontSize: "16px",
                    lineHeight: "19px",
                    color: "#FFFFFF",
                  }}
                >
                  {name}
                </div>
                <div
                  style={{
                    position: "absolute",
                    left: "27px",
                    top: "34px",
                    fontWeight: 500,
                    fontSize: "13px",
                    lineHeight: "16px",
                    color: "#A89B8C",
                  }}
                >
                  {last}
                </div>
                <button
                  type="button"
                  onClick={() => void handleRemove(String(d.id ?? ""))}
                  disabled={removing === String(d.id ?? "")}
                  aria-label="Отвязать устройство"
                  style={{
                    position: "absolute", left: "300px", top: "18px",
                    width: 32, height: 32, borderRadius: "50%", border: "none",
                    background: "rgba(255,77,77,0.14)", cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    opacity: removing === String(d.id ?? "") ? 0.5 : 1,
                  }}
                >
                  <MSIcon name="close" style={{ color: "#FF6B6B", fontSize: 20 }} />
                </button>
              </div>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => navigate("/subscription/increase")}
          style={{
            position: "absolute",
            width: "350px",
            height: "50px",
            left: "26px",
            top: "731px",
            background: "rgba(51, 51, 51, 0.71)",
            borderRadius: "21px",
            border: "none",
            padding: 0,
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ position: "absolute", width: "24px", height: "24px", left: "19px", top: "13px" }}>
            <PlusOutline24 />
          </span>
          <span
            style={{
              position: "absolute",
              width: "234px",
              height: "21px",
              left: "49px",
              top: "14px",
              fontFamily: "'Outfit', system-ui, sans-serif",
              fontWeight: 600,
              fontSize: "16px",
              lineHeight: "19px",
              display: "flex",
              alignItems: "center",
              color: "#FFFFFF",
            }}
          >
            Докупить устройство
          </span>
        </button>
      </div>
    </div>
  );
}
