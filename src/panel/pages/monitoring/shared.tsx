import React from 'react';

export type MonDot = 'grey' | 'red' | 'yellow' | 'blue' | 'green';
export type MonStatus = 'idle' | 'connecting' | 'green' | 'yellow' | 'orange' | 'red';

export type MonNodeBrief = { id: number; name: string; ip: string; port: number; status: MonStatus; status_label: string; enabled: boolean; agent_version?: string | null; agent_outdated?: boolean; can_self_update?: boolean; dot: MonDot; dot_reason: string };

export type MonIncident = { id: number; kind: string; severity: 'critical' | 'warning' | 'info'; title: string; details?: string | null; started_at: string; resolved_at?: string | null; timeline?: { at: string; text: string }[] };

/** Деление полосы доступности: [начало, статус 0..3, минут недоступен, минут всего]. */
export type Beat = [number, number, number, number];

export type MonDetail = MonNodeBrief & {
  created_at: string; started_at?: string | null; last_seen?: string | null; last_error?: string | null;
  agent_ok: boolean; agent_version?: string | null; uptime?: number | null; cores?: number | null;
  live: Record<string, number | null>; speed_running: boolean;
  last_speed?: { ts: number; ok: number; down?: number | null; up?: number | null; ping_ms?: number | null; error?: string | null } | null;
  ping: { last?: { ts: number; sent: number; lost: number; rtt_ms?: number | null } | null; uptime_24h?: number | null; uptime_7d?: number | null };
  vless: { configured: boolean; info?: { host: string; port: number; net: string; sec: string; name: string } | null; ok?: number | null; checked_at?: string | null; error?: string | null; uptime_24h?: number | null };
  payment: { date?: string | null; url?: string | null };
  incidents: MonIncident[]; open_incidents: number;
  agent_outdated?: boolean; rebooting?: boolean;
  latest_version?: string | null; can_self_update?: boolean; can_reboot?: boolean;
  update?: { target?: string | null; requested_at?: string | null; state?: { ok: boolean; error?: string; version?: string; at?: number } | null };
  beats_24h?: Beat[]; beats_7d?: Beat[];
};

const BEAT_COLORS = ['rgba(255,255,255,0.08)', '#34d399', '#facc15', '#ff6b6b'];
const BEAT_LABEL = ['нет данных', 'работал', 'были потери или агент не отвечал', 'был недоступен'];

const beatTime = (t: number, withDate: boolean) => {
  const d = new Date(t * 1000); const p = (n: number) => String(n).padStart(2, '0');
  return `${withDate ? `${p(d.getDate())}.${p(d.getMonth() + 1)} ` : ''}${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * Полоса доступности как в Uptime Kuma: деления слева (давно) направо (сейчас).
 * Зелёное — работал, жёлтое — были потери/агент молчал, красное — был недоступен.
 */
export const UptimeBar: React.FC<{ beats: Beat[]; height?: number; gap?: number; showAxis?: boolean; leftLabel?: string }> =
  ({ beats, height = 26, gap = 2, showAxis = false, leftLabel }) => {
    if (!beats.length || beats.every((b) => b[1] === 0)) return <span className="faint" style={{ fontSize: 12 }}>нет данных</span>;
    const step = beats.length > 1 ? beats[1][0] - beats[0][0] : 60;
    const withDate = step * beats.length > 86400;
    return (
      <div style={{ minWidth: 0 }}>
        <div className="flex" style={{ gap: beats.length > 60 ? `min(${gap}px, 0.3vw)` : gap, height, alignItems: 'stretch', overflow: 'hidden' }}>
          {beats.map((b, i) => {
            const [t, st, down, n] = b;
            const tip = `${beatTime(t, withDate)}–${beatTime(t + step, withDate)} · ${BEAT_LABEL[st]}${st === 3 && n ? ` ${down} из ${n} мин` : ''}`;
            return <span key={i} title={tip} style={{ flex: 1, minWidth: 0, borderRadius: height > 14 ? (beats.length > 60 ? 2 : 3) : 2, background: BEAT_COLORS[st], opacity: st === 1 ? 0.85 : 1 }} />;
          })}
        </div>
        {showAxis && (
          <div className="flex justify-between faint" style={{ fontSize: 11, marginTop: 6 }}>
            <span>{leftLabel || beatTime(beats[0][0], withDate)}</span><span>сейчас</span>
          </div>
        )}
      </div>
    );
  };

export const uptimeColor = (p?: number | null) => (p == null ? undefined : p >= 99.9 ? '#34d399' : p >= 99 ? '#facc15' : '#ff6b6b');

export const MON_COLORS: Record<MonStatus, string> = {
  idle: 'rgba(255,255,255,0.28)', connecting: '#60a5fa', green: '#34d399', yellow: '#facc15', orange: '#fb923c', red: '#ff6b6b',
};

if (typeof document !== 'undefined' && !document.getElementById('mon-pulse-css')) {
  const st = document.createElement('style'); st.id = 'mon-pulse-css';
  st.textContent = '@keyframes monPulse{0%,100%{opacity:1}50%{opacity:.35}}';
  document.head.appendChild(st);
}

/** Команда установки/обновления агента на сервере (адрес панели — запасной источник обновлений). */
export const agentCmd = (mode: 'install' | 'update') =>
  `curl -fsSL ${window.location.origin}/node.sh -o node.sh && sudo bash node.sh ${mode} --panel ${window.location.origin}`;

export const DOT_COLORS: Record<MonDot, string> = {
  grey: 'rgba(255,255,255,0.28)', red: '#ff6b6b', yellow: '#facc15', blue: '#60a5fa', green: '#34d399',
};
export const DOT_LEGEND: [MonDot, string][] = [
  ['green', 'всё работает'], ['yellow', 'подключение, сбой или перегрузка'], ['red', 'агент или VLESS недоступен'],
  ['blue', 'есть обновление агента'], ['grey', 'выключено'],
];

/** Кружок статуса ноды; причина — во всплывающей подсказке. */
export const NodeDot: React.FC<{ dot: MonDot; reason?: string; size?: number }> = ({ dot, reason, size = 10 }) => (
  <span title={reason} style={{
    width: size, height: size, borderRadius: '50%', background: DOT_COLORS[dot], flex: 'none', display: 'inline-block',
    boxShadow: dot === 'grey' ? 'none' : `0 0 0 3px ${DOT_COLORS[dot]}22`,
    animation: reason === 'Подключение к агенту…' ? 'monPulse 1.4s ease-in-out infinite' : undefined,
  }} />
);

export const StatusDot: React.FC<{ s: MonStatus; size?: number }> = ({ s, size = 10 }) => (
  <span style={{
    width: size, height: size, borderRadius: '50%', background: MON_COLORS[s], flex: 'none', display: 'inline-block',
    boxShadow: s === 'idle' ? 'none' : `0 0 0 3px ${MON_COLORS[s]}22`,
    animation: s === 'connecting' ? 'monPulse 1.4s ease-in-out infinite' : undefined,
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
