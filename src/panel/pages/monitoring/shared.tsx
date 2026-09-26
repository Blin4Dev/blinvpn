import React from 'react';

export type MonStatus = 'idle' | 'green' | 'yellow' | 'orange' | 'red';

export type MonNodeBrief = { id: number; name: string; ip: string; port: number; status: MonStatus; status_label: string; enabled: boolean };

export type MonIncident = { id: number; kind: string; severity: 'critical' | 'warning' | 'info'; title: string; details?: string | null; started_at: string; resolved_at?: string | null };

export type MonDetail = MonNodeBrief & {
  created_at: string; started_at?: string | null; last_seen?: string | null; last_error?: string | null;
  agent_ok: boolean; agent_version?: string | null; uptime?: number | null; cores?: number | null;
  live: Record<string, number | null>; speed_running: boolean;
  last_speed?: { ts: number; ok: number; down?: number | null; up?: number | null; ping_ms?: number | null; error?: string | null } | null;
  ping: { last?: { ts: number; sent: number; lost: number; rtt_ms?: number | null } | null; uptime_24h?: number | null; uptime_7d?: number | null };
  vless: { configured: boolean; info?: { host: string; port: number; net: string; sec: string; name: string } | null; ok?: number | null; checked_at?: string | null; error?: string | null; uptime_24h?: number | null };
  payment: { date?: string | null; url?: string | null };
  incidents: MonIncident[]; open_incidents: number;
};

export const MON_COLORS: Record<MonStatus, string> = {
  idle: 'rgba(255,255,255,0.28)', green: '#34d399', yellow: '#facc15', orange: '#fb923c', red: '#ff6b6b',
};

export const StatusDot: React.FC<{ s: MonStatus; size?: number }> = ({ s, size = 10 }) => (
  <span style={{
    width: size, height: size, borderRadius: '50%', background: MON_COLORS[s], flex: 'none', display: 'inline-block',
    boxShadow: s === 'idle' ? 'none' : `0 0 0 3px ${MON_COLORS[s]}22`,
  }} />
);

export const fmtBytes = (v?: number | null, digits = 1): string => {
  if (v == null || !isFinite(Number(v))) return '—';
  const n = Number(v);
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0; let x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(i === 0 ? 0 : digits)} ${u[i]}`;
};

export const fmtRate = (bps?: number | null): string => (bps == null ? '—' : `${fmtBytes(bps)}/с`);

export const fmtMbit = (v?: number | null): string => (v == null ? '—' : `${Number(v) >= 100 ? Number(v).toFixed(0) : Number(v).toFixed(1)} Мбит/с`);

export const fmtUptime = (sec?: number | null): string => {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} д ${h} ч` : h ? `${h} ч ${m} мин` : `${m} мин`;
};

export const pct = (a?: number | null, b?: number | null) => (a != null && b ? (100 * Number(a)) / Number(b) : null);

export const fmtDur = (fromIso: string, toIso?: string | null) => {
  const s = Math.max(0, ((toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} мин`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч ${Math.round((s % 3600) / 60)} мин`;
  return `${Math.floor(s / 86400)} д ${Math.floor((s % 86400) / 3600)} ч`;
};

export const toLocalInput = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
