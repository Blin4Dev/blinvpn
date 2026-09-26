import React from 'react';
import { createPortal } from 'react-dom';
import {
  X, CheckCircle, AlertCircle, Loader,
} from 'lucide-react';
import { fmtDelta } from '../lib/format';
import type { Toast, UserStatus } from '../lib/types';

export const Spinner: React.FC<{ size?: number; className?: string }> = ({ size = 20, className = '' }) => (
  <Loader size={size} className={`animate-spin ${className}`} style={{ color: 'var(--muted)' }} />
);

// ── Modal shell ───────────────────────────────────────────
export const Modal: React.FC<{
  onClose: () => void;
  title?: React.ReactNode;
  icon?: React.ElementType;
  footer?: React.ReactNode;
  width?: number;
  children: React.ReactNode;
  z?: number;
}> = ({ onClose, title, icon: Icon, footer, width = 460, children, z = 60 }) => createPortal(
  <div className="modal-backdrop" style={{ zIndex: z }} onClick={onClose}>
    <div className="modal" style={{ maxWidth: width }} onClick={(e) => e.stopPropagation()}>
      {title != null && (
        <div className="modal-head">
          <div className="modal-title">{Icon && <Icon size={18} className="faint" />}{title}</div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть"><X size={18} /></button>
        </div>
      )}
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </div>
  </div>,
  document.body,
);

// ── Toggle ────────────────────────────────────────────────
export const Toggle: React.FC<{ on: boolean; onChange: () => void }> = ({ on, onChange }) => (
  <button type="button" className={`toggle ${on ? 'on' : ''}`} onClick={onChange} aria-pressed={on}>
    <span className="knob" />
  </button>
);

// ── Segmented control ─────────────────────────────────────
export function Segmented<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[];
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} className={`seg-item ${value === o.value ? 'on' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────
export const Stat: React.FC<{ title: string; value: React.ReactNode; icon: React.ElementType; sub?: string }> =
  ({ title, value, icon: Icon, sub }) => (
    <div className="stat">
      <div className="stat-top">
        <span className="stat-label">{title}</span>
        <Icon size={18} className="stat-ico" />
      </div>
      <div className="flex items-baseline gap-2">
        <span className="stat-value">{value}</span>
        {sub && <span className="stat-sub">{sub}</span>}
      </div>
    </div>
  );

// ── Pagination ────────────────────────────────────────────
export const PaginationBar: React.FC<{
  page: number; totalPages: number; total: number; loading?: boolean;
  onPrev: () => void; onNext: () => void; totalLabel?: string;
}> = ({ page, totalPages, total, loading, onPrev, onNext, totalLabel = 'Всего в базе' }) => (
  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-1">
    <div className="flex items-center gap-2 sub">
      {loading && <Spinner size={14} />}
      <span>{totalLabel}: <span style={{ color: 'var(--text)', fontWeight: 600 }}>{total.toLocaleString('ru-RU')}</span></span>
    </div>
    <div className="flex items-center gap-2">
      <button className="btn sm" onClick={onPrev} disabled={page <= 1 || loading}>Назад</button>
      <span className="sub tabular-nums" style={{ minWidth: 64, textAlign: 'center' }}>{page} / {totalPages}</span>
      <button className="btn sm" onClick={onNext} disabled={page >= totalPages || loading}>Вперёд</button>
    </div>
  </div>
);

// ── Toasts ────────────────────────────────────────────────
export const ToastContainer: React.FC<{ toasts: Toast[]; removeToast: (id: number) => void }> = ({ toasts, removeToast }) => (
  <div className="toasts">
    {toasts.map((t) => (
      <div key={t.id} className={`toast ${t.type === 'error' ? 'error' : ''}`} role="alert">
        {t.type === 'error' ? <AlertCircle size={18} className="faint" style={{ marginTop: 1 }} />
          : <CheckCircle size={18} style={{ marginTop: 1 }} />}
        <div className="flex-1">
          <div className="toast-title">{t.title}</div>
          {t.message && <div className="toast-msg">{t.message}</div>}
        </div>
        <button className="icon-btn" style={{ width: 24, height: 24, border: 0 }} onClick={() => removeToast(t.id)}><X size={14} /></button>
      </div>
    ))}
  </div>
);

// status → badge class
export const userStatusBadge = (s: UserStatus, blacklist?: boolean) => {
  if (blacklist || s === 'Banned') return { cls: 'danger', label: 'Заблокирован' };
  if (s === 'Active') return { cls: 'solid', label: 'Активен' };
  if (s === 'Trial') return { cls: 'mute', label: 'Пробная' };
  if (s === 'None') return { cls: 'line', label: 'Нет подписки' };
  return { cls: 'line', label: 'Истекла' };
};

// ── page header helper ────────────────────────────────────
export const PageHead: React.FC<{ title: string; sub?: string; children?: React.ReactNode }> = ({ title, sub, children }) => (
  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
    <div><h2 className="h-page">{title}</h2>{sub && <p className="sub mt-1">{sub}</p>}</div>
    {children}
  </div>
);

export const Delta: React.FC<{ v?: number | null; suffix?: string }> = ({ v, suffix = 'к прошлому периоду' }) => {
  if (v == null) return <span className="faint">{suffix ? 'нет данных для сравнения' : ''}</span>;
  const up = v > 0; const flat = v === 0;
  return <span style={{ color: flat ? 'var(--muted)' : up ? '#34d399' : 'var(--danger)' }}>{up ? '↑' : flat ? '→' : '↓'} {fmtDelta(v)} <span className="faint">{suffix}</span></span>;
};

// Карточка-показатель с подписью под числом (Stat принимает sub только строкой)
export const Kpi: React.FC<{ title: string; value: React.ReactNode; icon?: React.ElementType; foot?: React.ReactNode; hint?: string }> = ({ title, value, icon: Icon, foot, hint }) => (
  <div className="stat" title={hint}>
    <div className="stat-top"><span className="stat-label">{title}</span>{Icon && <Icon size={18} className="stat-ico" />}</div>
    <span className="stat-value" style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    {foot != null && <div style={{ fontSize: 12, marginTop: 6 }} className="sub">{foot}</div>}
  </div>
);

export const StatSection: React.FC<{ title: string; sub?: string; children: React.ReactNode }> = ({ title, sub, children }) => (
  <section className="flex flex-col gap-4">
    <div><h3 className="h-page" style={{ fontSize: 17 }}>{title}</h3>{sub && <p className="sub" style={{ marginTop: 2 }}>{sub}</p>}</div>
    {children}
  </section>
);

export const Panel: React.FC<{ title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }> = ({ title, right, children, className = '' }) => (
  <div className={`card ${className}`} style={{ padding: 20 }}>
    <div className="flex items-center justify-between gap-3 mb-4"><h4 className="h-sec">{title}</h4>{right}</div>
    {children}
  </div>
);

export const Row: React.FC<{ k: React.ReactNode; v: React.ReactNode; hint?: string }> = ({ k, v, hint }) => (
  <div className="flex items-center justify-between gap-3" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)', fontSize: 14 }} title={hint}>
    <span className="muted">{k}</span><span style={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{v}</span>
  </div>
);

export const InfoRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center justify-between gap-3" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
    <span className="sub" style={{ minWidth: 140 }}>{label}</span>
    <span className="flex items-center gap-2" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>{children}</span>
  </div>
);

export const DCard: React.FC<{ title?: React.ReactNode; icon?: React.ElementType; children: React.ReactNode; actions?: React.ReactNode }> = ({ title, icon: Icon, children, actions }) => (
  <div className="card" style={{ padding: 18 }}>
    {(title || actions) && (
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">{Icon && <Icon size={16} className="faint" />}{title && <span className="h-sec">{title}</span>}</div>
        {actions}
      </div>
    )}
    {children}
  </div>
);
