import React from 'react';
import { ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { fmtMoney } from '../../lib/format';

export type Interval = [string, string];
export type Day = { day: string; intervals: Interval[]; pay?: number };

export const ROLE_RU: Record<string, string> = { curator: 'Куратор', operator: 'Оператор', owner: 'Администратор' };
export const WEEK = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

export const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s: string, n: number) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
export const monthStart = (s: string) => s.slice(0, 8) + '01';
export const monthEnd = (s: string) => { const d = parseYmd(monthStart(s)); d.setMonth(d.getMonth() + 1); d.setDate(0); return ymd(d); };
export const shiftMonth = (s: string, n: number) => { const d = parseYmd(monthStart(s)); d.setMonth(d.getMonth() + n); return ymd(d); };
export const ruDate = (s: string) => { const d = parseYmd(s); return `${d.getDate()} ${['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][d.getMonth()]}`; };
export const hoursText = (iv: Interval[]) => iv.map(([a, b]) => `${a}–${b}`).join(', ');
export const workedMinutes = (iv: Interval[]) => iv.reduce((s, [a, b]) => s + (toMin(b) - toMin(a)), 0);
const toMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const fromMin = (m: number) => { const x = Math.min(m, 1439); return `${pad(Math.floor(x / 60))}:${pad(x % 60)}`; };
export const money = (n: number) => fmtMoney(Number(n || 0));

export const ShiftBadge: React.FC<{ shift?: { working_today: boolean; on_shift: boolean; intervals: string[][] } }> = ({ shift }) => {
  if (!shift) return null;
  if (!shift.working_today) return <span className="badge mute">сегодня выходной</span>;
  return <span className={`badge ${shift.on_shift ? 'solid' : 'mute'}`}>{shift.on_shift ? 'на смене' : 'сегодня'} · {hoursText(shift.intervals as Interval[])}</span>;
};

// части рабочего дня (+ перерыв = ещё одна часть)
export const IntervalsEditor: React.FC<{ value: Interval[]; onChange: (v: Interval[]) => void }> = ({ value, onChange }) => {
  const set = (i: number, j: 0 | 1, v: string) => onChange(value.map((x, k) => (k === i ? (j === 0 ? [v, x[1]] : [x[0], v]) : x)) as Interval[]);
  const addBreak = () => {
    const last = value[value.length - 1];
    const start = last ? Math.min(toMin(last[1]) + 60, 23 * 60) : 10 * 60;
    onChange([...value, [fromMin(start), fromMin(start + 180)]]);
  };
  return (
    <div className="flex flex-col gap-2">
      {value.map((x, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="sub" style={{ width: 70, fontSize: 12 }}>{i === 0 ? 'Работа' : `Часть ${i + 1}`}</span>
          <input className="input" type="time" value={x[0]} onChange={(e) => set(i, 0, e.target.value)} style={{ width: 120 }} />
          <span className="sub">—</span>
          <input className="input" type="time" value={x[1] === '24:00' ? '23:59' : x[1]} onChange={(e) => set(i, 1, e.target.value)} style={{ width: 120 }} />
          {value.length > 1 && <button className="icon-btn" title="Убрать часть" onClick={() => onChange(value.filter((_, k) => k !== i))}><Trash2 size={14} /></button>}
        </div>
      ))}
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={addBreak} disabled={value.length >= 8}><Plus size={13} /> Перерыв (ещё часть дня)</button>
      <div className="faint" style={{ fontSize: 12 }}>Время московское. Всего: {Math.floor(workedMinutes(value) / 60)} ч {workedMinutes(value) % 60 ? `${workedMinutes(value) % 60} мин` : ''}</div>
    </div>
  );
};

// месяц: рабочие дни (+ оплата, если showPay)
export const MonthCalendar: React.FC<{
  month: string; today: string; days: Record<string, Day>; showPay?: boolean;
  onMonth: (m: string) => void; onDay?: (day: string) => void;
}> = ({ month, today, days, showPay, onMonth, onDay }) => {
  const first = parseYmd(monthStart(month));
  const lead = (first.getDay() + 6) % 7;
  const last = parseYmd(monthEnd(month)).getDate();
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: last }, (_, i) => ymd(new Date(first.getFullYear(), first.getMonth(), i + 1)))];
  while (cells.length % 7) cells.push(null);
  const work = Object.values(days).filter((d) => d.day.slice(0, 7) === month.slice(0, 7));
  return (
    <div>
      <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
        <button className="icon-btn" onClick={() => onMonth(shiftMonth(month, -1))}><ChevronLeft size={16} /></button>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: 600 }}>{MONTHS[first.getMonth()]} {first.getFullYear()}</div>
          <div className="faint" style={{ fontSize: 12 }}>
            рабочих дней: {work.length}{showPay ? ` · ${money(work.reduce((s, d) => s + (d.pay || 0), 0))}` : ''}
          </div>
        </div>
        <button className="icon-btn" onClick={() => onMonth(shiftMonth(month, 1))}><ChevronRight size={16} /></button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6 }}>
        {WEEK.map((w, i) => <div key={w} className="faint" style={{ fontSize: 11, textAlign: 'center', color: i > 4 ? 'var(--danger)' : undefined }}>{w}</div>)}
        {cells.map((c, i) => {
          if (!c) return <div key={i} />;
          const d = days[c];
          const past = c < today;
          return (
            <button key={c} onClick={onDay ? () => onDay(c) : undefined} disabled={!onDay}
              style={{
                minHeight: 74, padding: 6, textAlign: 'left', borderRadius: 10, font: 'inherit', color: 'inherit', cursor: onDay ? 'pointer' : 'default',
                border: c === today ? '1px solid #fff' : '1px solid var(--border)', opacity: past ? 0.55 : 1,
                background: d ? 'rgba(255,255,255,0.08)' : 'transparent', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0,
              }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{parseYmd(c).getDate()}</span>
              {d ? (<>
                {d.intervals.map(([a, b], k) => <span key={k} style={{ fontSize: 10.5, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a}–{b}</span>)}
                {showPay && d.pay != null && <span className="faint" style={{ fontSize: 10.5 }}>{money(d.pay)}</span>}
              </>) : <span className="faint" style={{ fontSize: 10.5 }}>выходной</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export const StatBox: React.FC<{ label: string; value: React.ReactNode; hint?: string }> = ({ label, value, hint }) => (
  <div className="card" style={{ padding: 14 }}>
    <div className="faint" style={{ fontSize: 12 }}>{label}</div>
    <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value}</div>
    {hint && <div className="faint" style={{ fontSize: 11, marginTop: 2 }}>{hint}</div>}
  </div>
);
