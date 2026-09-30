import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** Пошаговый мастер: номер шага, заголовок; открыт только текущий шаг. */
export const Steps: React.FC<{ current: number; steps: { title: string; done?: boolean; body: React.ReactNode }[] }> = ({ current, steps }) => (
  <div className="card" style={{ padding: 6 }}>
    {steps.map((s, i) => {
      const done = s.done || i < current;
      const open = i === current;
      return (
        <div key={i} style={{ padding: '14px 14px', borderTop: i ? '1px solid var(--border)' : 'none', opacity: !open && !done ? 0.45 : 1 }}>
          <div className="flex items-center gap-3">
            <span style={{
              width: 26, height: 26, borderRadius: 13, flex: 'none', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 700,
              background: done ? 'var(--accent)' : open ? '#fff' : 'var(--surface-active)', color: done ? '#fff' : open ? '#000' : 'var(--muted)',
            }}>{done ? <Check size={14} /> : i + 1}</span>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{s.title}</span>
          </div>
          {open && <div style={{ marginTop: 14, marginLeft: 38 }} className="flex flex-col gap-3">{s.body}</div>}
        </div>
      );
    })}
  </div>
);

/** Нумерованная инструкция. */
export const HowTo: React.FC<{ items: React.ReactNode[] }> = ({ items }) => (
  <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, lineHeight: 1.5 }}>
    {items.map((x, i) => <li key={i}>{x}</li>)}
  </ol>
);

/** Кнопка «Скопировать» с отметкой. */
export const CopyBtn: React.FC<{ text: string; label?: string }> = ({ text, label = 'Скопировать' }) => {
  const [ok, setOk] = useState(false);
  return (
    <button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); }); }}>
      {ok ? <Check size={14} /> : <Copy size={14} />} {ok ? 'Скопировано' : label}
    </button>
  );
};

/** Лог выполнения задания на сервере. */
export const JobLog: React.FC<{ lines: string[] }> = ({ lines }) => lines.length ? (
  <pre className="inset mono" style={{ margin: 0, padding: 10, fontSize: 12, lineHeight: 1.5, maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
    {lines.join('\n')}
  </pre>
) : null;

export const Ok: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex items-center gap-2" style={{ color: '#34d399', fontSize: 14 }}><Check size={16} /> {children}</div>
);

export const Err: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ color: 'var(--danger)', fontSize: 14, lineHeight: 1.5 }}>{children}</div>
);
