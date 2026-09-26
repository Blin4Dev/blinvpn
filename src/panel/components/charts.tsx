import React, { useState, useRef } from 'react';
import { fmtDateTime, fmtInt, pctStr } from '../lib/format';

// ── Горизонтальные столбики (распределение, способы оплаты) ──
export const HBarChart: React.FC<{
  data: { label: string; value: number }[];
  format?: (v: number) => string;
  showShare?: boolean;
  dangerLabels?: string[];
}> = ({ data, format = (v) => String(v), showShare = true, dangerLabels = [] }) => {
  if (!data.length) return <p className="sub">Нет данных</p>;
  const max = Math.max(...data.map((d) => d.value), 1);
  const total = data.reduce((a, d) => a + d.value, 0) || 1;
  const topIdx = data.reduce((mi, d, i, a) => (d.value > a[mi].value ? i : mi), 0);
  return (
    <div className="hbars">
      {data.map((d, i) => (
        <div key={d.label} className={`hbar-row ${dangerLabels.includes(d.label) ? 'danger' : i === topIdx && d.value > 0 ? 'top' : ''}`} title={`${d.label}: ${format(d.value)}`}>
          <span className="hbar-label">{d.label}</span>
          <div className="hbar-track"><div className="hbar-fill" style={{ width: `${d.value ? Math.max(2, (d.value / max) * 100) : 0}%` }} /></div>
          <span className="hbar-val">{format(d.value)}{showShare && <span className="faint"> · {Math.round((d.value / total) * 100)}%</span>}</span>
        </div>
      ))}
    </div>
  );
};

// ── Линейный график с подсказкой при наведении ─────────────
export type ChartSeries = { name: string; color: string; values: (number | null)[]; dashed?: boolean };

export const LineChart: React.FC<{
  times: number[]; series: ChartSeries[]; format: (v: number) => string; yMax?: number; height?: number;
  bars?: { values: (number | null)[]; color: string; name: string; format: (v: number) => string };
  range: string;
}> = ({ times, series, format, yMax, height = 170, bars, range }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 1000; const H = height; const padL = 0; const padB = 18;
  if (!times.length) return <div className="sub" style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, border: '1px dashed var(--border)', borderRadius: 'var(--r-md)' }}>Нет данных за этот период</div>;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const top = yMax ?? Math.max(1, ...all) * 1.15;
  const t0 = times[0]; const t1 = times[times.length - 1] || t0 + 1;
  const x = (t: number) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL);
  const y = (v: number) => (H - padB) - (Math.min(v, top) / top) * (H - padB - 6);
  const path = (vals: (number | null)[]) => {
    let d = ''; let pen = false;
    vals.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(times[i]).toFixed(1)},${y(v).toFixed(1)} `; pen = true;
    });
    return d;
  };
  const ticks = [0, 0.5, 1].map((k) => top * k);
  const labelTime = (t: number) => {
    const d = new Date(t * 1000); const p = (n: number) => String(n).padStart(2, '0');
    return range === '7d' ? `${p(d.getDate())}.${p(d.getMonth() + 1)}` : `${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const xLabels = [0, 0.25, 0.5, 0.75, 1].map((k) => t0 + (t1 - t0) * k);
  const onMove = (e: React.MouseEvent) => {
    const r = ref.current?.getBoundingClientRect(); if (!r) return;
    const tt = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
    let best = 0; let bd = Infinity;
    times.forEach((t, i) => { const d = Math.abs(t - tt); if (d < bd) { bd = d; best = i; } });
    setHover(best);
  };
  const barW = Math.max(1.5, (W / Math.max(1, times.length)) * 0.8);
  return (
    <div ref={ref} style={{ position: 'relative' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: H, display: 'block' }}>
        {ticks.map((v, i) => (
          <line key={i} x1={0} x2={W} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.07)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        {bars && bars.values.map((v, i) => (v ? (
          <rect key={i} x={x(times[i]) - barW / 2} y={6} width={barW} height={H - padB - 6} fill={bars.color} opacity={Math.min(0.85, 0.2 + v / 100)} />
        ) : null))}
        {series.map((s) => (
          <path key={s.name} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={1.6} strokeDasharray={s.dashed ? '4 4' : undefined}
            vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {hover != null && <line x1={x(times[hover])} x2={x(times[hover])} y1={0} y2={H - padB} stroke="rgba(255,255,255,0.35)" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      </svg>
      <div style={{ position: 'absolute', top: 0, left: 4, fontSize: 11 }} className="faint">{format(top)}</div>
      <div className="flex justify-between faint" style={{ fontSize: 11, marginTop: -14, pointerEvents: 'none' }}>
        {xLabels.map((t, i) => <span key={i}>{labelTime(t)}</span>)}
      </div>
      {hover != null && (
        <div className="card" style={{
          position: 'absolute', top: 8, left: `${Math.min(70, Math.max(0, ((x(times[hover]) / W) * 100) - 12))}%`, padding: '8px 10px',
          pointerEvents: 'none', fontSize: 12, minWidth: 150, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
        }}>
          <div className="faint" style={{ marginBottom: 4 }}>{fmtDateTime(new Date(times[hover] * 1000).toISOString()).slice(0, 16)}</div>
          {series.map((s) => (
            <div key={s.name} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1"><span style={{ width: 8, height: 2, background: s.color, display: 'inline-block' }} />{s.name}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{s.values[hover] == null ? '—' : format(Number(s.values[hover]))}</span>
            </div>
          ))}
          {bars && (
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1"><span style={{ width: 8, height: 8, background: bars.color, display: 'inline-block' }} />{bars.name}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{bars.values[hover] == null ? '—' : bars.format(Number(bars.values[hover]))}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const Legend: React.FC<{ items: { name: string; color: string; bar?: boolean }[] }> = ({ items }) => (
  <div className="flex items-center gap-3" style={{ fontSize: 12 }}>
    {items.map((i) => (
      <span key={i.name} className="flex items-center gap-1 sub">
        <span style={{ width: i.bar ? 8 : 10, height: i.bar ? 8 : 2, background: i.color, display: 'inline-block', borderRadius: 1 }} />{i.name}
      </span>
    ))}
  </div>
);

// Столбики с подсказкой при наведении
export const Columns: React.FC<{ data: { label: string; value: number; sub?: string }[]; format: (v: number) => string; height?: number; every?: number }> = ({ data, format, height = 150, every = 1 }) => {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div style={{ position: 'relative' }}>
      <div className="flex items-end" style={{ gap: 3, height }} onMouseLeave={() => setHover(null)}>
        {data.map((d, i) => (
          <div key={i} onMouseEnter={() => setHover(i)} style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end', cursor: 'default' }}>
            <div style={{
              width: '100%', height: `${d.value ? Math.max(3, (d.value / max) * 100) : 1.5}%`, borderRadius: '4px 4px 1px 1px',
              background: hover === i ? '#fff' : d.value ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.12)', transition: 'background var(--t)',
            }} />
          </div>
        ))}
      </div>
      <div className="flex faint" style={{ gap: 3, fontSize: 11, marginTop: 6 }}>
        {data.map((d, i) => <span key={i} style={{ flex: 1, textAlign: 'center', overflow: 'hidden', whiteSpace: 'nowrap' }}>{i % every === 0 ? d.label : ''}</span>)}
      </div>
      {hover != null && data[hover] && (
        <div className="card" style={{ position: 'absolute', top: -6, left: `${Math.min(78, Math.max(0, (hover / data.length) * 100 - 8))}%`, padding: '7px 10px', fontSize: 12, pointerEvents: 'none', boxShadow: '0 8px 24px rgba(0,0,0,0.6)', whiteSpace: 'nowrap' }}>
          <div className="faint">{data[hover].label}</div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{format(data[hover].value)}</div>
          {data[hover].sub && <div className="sub">{data[hover].sub}</div>}
        </div>
      )}
    </div>
  );
};

export const Funnel: React.FC<{ steps: { label: string; value: number }[] }> = ({ steps }) => {
  const top = Math.max(1, steps[0]?.value || 0);
  return (
    <div className="flex flex-col gap-3">
      {steps.map((s, i) => (
        <div key={s.label}>
          <div className="flex justify-between" style={{ fontSize: 13, marginBottom: 6 }}>
            <span className="muted">{s.label}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              <b style={{ fontWeight: 600 }}>{fmtInt(s.value)}</b>
              <span className="faint"> · {pctStr((100 * s.value) / top)}{i > 0 && steps[i - 1].value ? ` · ${pctStr((100 * s.value) / steps[i - 1].value)} от прошлого шага` : ''}</span>
            </span>
          </div>
          <div style={{ height: 22, background: 'var(--surface-active)', borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.max(s.value ? 1.5 : 0, (100 * s.value) / top)}%`, background: `rgba(255,255,255,${0.75 - i * 0.18})`, borderRadius: 6, transition: 'width .4s ease' }} />
          </div>
        </div>
      ))}
    </div>
  );
};
