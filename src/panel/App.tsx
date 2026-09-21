import React, { useState, useEffect, useRef } from 'react';
import {
  Home, DollarSign, Users, Key, Mail, Gift, Percent, Link, Settings, Menu, X,
  CheckCircle, AlertCircle, CreditCard, Search, Filter, ArrowUpRight, ArrowDownLeft,
  Activity, Calendar, Download, Loader, Hash, Ban, Trophy, UserPlus, UserMinus, Clock,
  Edit2, Copy, Smartphone, Zap, Database, Bell, Wallet, Plus, Lock, Send,
  MousePointer, Layers, ToggleLeft, ToggleRight, Trash2, ChevronDown, Save,
  AlertTriangle, Cloud, RefreshCw, BarChart2, FileText, Shield, ArrowLeft, Snowflake,
  ClipboardList
} from 'lucide-react';

// ==========================================================
// 0. ENV & API
// ==========================================================

declare const importMeta: any | undefined;

const rawEnv: any =
  (typeof importMeta !== 'undefined' && importMeta.env) ||
  (typeof (window as any) !== 'undefined' && (window as any).__ENV__) ||
  {};

const BOT_USERNAME: string = rawEnv.VITE_BOT_USERNAME || rawEnv.REACT_APP_BOT_USERNAME || 'blinvpn_bot';

function getPanelToken(): string {
  return typeof window !== 'undefined' ? localStorage.getItem('panel_token') || '' : '';
}
function setPanelToken(token: string): void {
  if (typeof window !== 'undefined') localStorage.setItem('panel_token', token);
}
function clearPanelToken(): void {
  if (typeof window !== 'undefined') localStorage.removeItem('panel_token');
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<any> {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const url = `/api${cleanPath}`;
  const headers: any = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (cleanPath.startsWith('/panel')) {
    const token = getPanelToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    if (res.status === 401) {
      clearPanelToken();
      window.location.reload();
    }
    const text = await res.text();
    throw new Error(text || `Request failed with status ${res.status}`);
  }
  try { return await res.json(); } catch { return null; }
}

// ==========================================================
// 0.1 PAGINATION / SERVER-SIDE SEARCH
// ==========================================================

const PAGE_SIZE = 100;

function parseListResponse(res: any): { items: any[]; total: number | null } {
  if (Array.isArray(res)) return { items: res, total: null };
  if (res && typeof res === 'object') {
    const items =
      (Array.isArray(res.items) && res.items) ||
      (Array.isArray(res.data) && res.data) ||
      (Array.isArray(res.results) && res.results) ||
      (Array.isArray(res.rows) && res.rows) || [];
    const totalRaw = res.total ?? res.count ?? res.total_count ?? res.totalCount ?? null;
    const total = totalRaw == null ? null : Number(totalRaw);
    return { items, total: Number.isFinite(total as number) ? total : null };
  }
  return { items: [], total: null };
}

function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

interface UsePaginatedListOptions {
  basePath: string;
  search: string;
  extraParams?: Record<string, string | undefined>;
  mapItem: (raw: any) => any;
  clientFilter?: (item: any) => boolean;
  enabled?: boolean;
  reloadKey?: number;
}

function usePaginatedList(opts: UsePaginatedListOptions) {
  const { basePath, search, extraParams, mapItem, clientFilter, enabled = true, reloadKey = 0 } = opts;
  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const [page, setPageState] = useState(1);
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localReload, setLocalReload] = useState(0);
  const extraKey = JSON.stringify(extraParams || {});

  useEffect(() => { setPageState(1); }, [debouncedSearch, extraKey]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const offset = (page - 1) * PAGE_SIZE;
        const qp = new URLSearchParams();
        qp.set('limit', String(PAGE_SIZE));
        qp.set('offset', String(offset));
        qp.set('page', String(page));
        if (debouncedSearch) { qp.set('search', debouncedSearch); qp.set('q', debouncedSearch); }
        if (extraParams) {
          for (const [k, v] of Object.entries(extraParams)) {
            if (v != null && v !== '' && v !== 'all') qp.set(k, v);
          }
        }
        const res = await apiFetch(`${basePath}?${qp.toString()}`);
        if (cancelled) return;
        const { items: rawItems, total: serverTotal } = parseListResponse(res);
        const backendIgnoresPaging = rawItems.length > PAGE_SIZE;

        if (backendIgnoresPaging) {
          let all = rawItems.map(mapItem);
          if (debouncedSearch) {
            const q = debouncedSearch.toLowerCase();
            all = all.filter((it: any) => searchableMatch(it, q));
          }
          if (clientFilter) all = all.filter(clientFilter);
          const start = (page - 1) * PAGE_SIZE;
          setItems(all.slice(start, start + PAGE_SIZE));
          setTotal(all.length);
        } else {
          let pageItems = rawItems.map(mapItem);
          if (clientFilter) pageItems = pageItems.filter(clientFilter);
          let totalCount: number;
          if (serverTotal != null) totalCount = serverTotal;
          else if (pageItems.length < PAGE_SIZE) totalCount = offset + pageItems.length;
          else totalCount = offset + pageItems.length + 1;
          setItems(pageItems);
          setTotal(totalCount);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || 'Не удалось загрузить данные');
          setItems([]);
          setTotal(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePath, page, debouncedSearch, extraKey, enabled, reloadKey, localReload]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const setPage = (p: number) => setPageState(Math.min(Math.max(1, p), Math.max(1, totalPages)));

  return {
    items, total, page, totalPages, loading, error, setPage,
    nextPage: () => setPage(page + 1),
    prevPage: () => setPage(page - 1),
    reload: () => setLocalReload((n) => n + 1),
  };
}

function searchableMatch(item: any, q: string): boolean {
  const fields = [item.username, item.name, item.user, item.key, item.refCode,
    item.telegramId != null ? String(item.telegramId) : '', item.id != null ? String(item.id) : ''];
  return fields.filter((f) => f != null && f !== '').map((f) => String(f).toLowerCase()).join(' ').includes(q);
}

// ==========================================================
// 1. TYPES
// ==========================================================

type ToastType = 'success' | 'error' | 'info';
type TransactionType = 'income' | 'expense';
type UserStatus = 'Active' | 'Trial' | 'Banned' | 'Expired';
type KeyStatus = 'Active' | 'Expired' | 'Banned' | 'Blocked';

interface Toast { id: number; title: string; message?: string; type: ToastType; }

interface Transaction {
  id: number; user: string; amount: number; type: TransactionType;
  status: string; method: string; date: string; hash: string;
}

interface User {
  id: number; telegramId: number; username: string; balance: number; status: UserStatus;
  regDate: string; paidUntil: string; refCode: string; isPartner: boolean;
  partnerBalance: number; partnerRate: number;
  referrals: number; inBlacklist: boolean;
}

interface KeyItem {
  id: number; key: string; user: string; status: KeyStatus; expiry: number;
  trafficUsed: number; trafficLimit: number; devicesUsed: number; devicesLimit: number;
}

interface Promo {
  id: number; code: string; name: string; value: string; uses: number; limit: number; expires: string;
}

interface TrackingLink {
  id: number; code: string; name: string; promocode: string | null; welcome_message: string | null;
  url: string; clicks: number; is_active: boolean; created_at: string; unique_users: number;
  new_users: number; total_revenue: number; paid_users: number; active_subscriptions: number;
  total_keys: number; conversion_rate: number;
}

interface TrackingLinkUser {
  user_id: number; telegram_id: number; username: string | null; full_name: string | null;
  is_new_user: boolean; visited_at: string; trial_used: boolean; total_spent: number;
  keys_count: number; active_keys: number; has_paid: boolean;
}

// ==========================================================
// 2. SHARED HELPERS & PRIMITIVES
// ==========================================================

const fmtInt = (v: number | null | undefined) => (v ?? 0).toLocaleString('ru-RU', { maximumFractionDigits: 0 });
const fmtMoney = (v: number | null | undefined) => `${fmtInt(v)} ₽`;
const fmtMoneyShort = (v: number | null | undefined) =>
  (v ?? 0) >= 1_000_000 ? `${((v ?? 0) / 1_000_000).toFixed(1)}M ₽` : fmtMoney(v);
const gb = (bytes: number) => (bytes / 1024 ** 3);

function toSeries(raw: any): { label: string; value: number }[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((d: any) => ({
    label: String(d.label ?? d.date ?? d.day ?? d.name ?? ''),
    value: Number(d.value ?? d.amount ?? d.revenue ?? d.total ?? d.count ?? 0) || 0,
  }));
}

const Spinner: React.FC<{ size?: number; className?: string }> = ({ size = 20, className = '' }) => (
  <Loader size={size} className={`animate-spin ${className}`} style={{ color: 'var(--muted)' }} />
);

// ── Modal shell ───────────────────────────────────────────
const Modal: React.FC<{
  onClose: () => void;
  title?: React.ReactNode;
  icon?: React.ElementType;
  footer?: React.ReactNode;
  width?: number;
  children: React.ReactNode;
  z?: number;
}> = ({ onClose, title, icon: Icon, footer, width = 460, children, z = 60 }) => (
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
  </div>
);

// ── Toggle ────────────────────────────────────────────────
const Toggle: React.FC<{ on: boolean; onChange: () => void }> = ({ on, onChange }) => (
  <button type="button" className={`toggle ${on ? 'on' : ''}`} onClick={onChange} aria-pressed={on}>
    <span className="knob" />
  </button>
);

// ── Segmented control ─────────────────────────────────────
function Segmented<T extends string>({ value, onChange, options }: {
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
const Stat: React.FC<{ title: string; value: React.ReactNode; icon: React.ElementType; sub?: string }> =
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

// ── Vertical bar chart (signature) ────────────────────────
const BarChart: React.FC<{
  data: { label: string; value: number }[];
  format?: (v: number) => string;
  height?: number;
}> = ({ data, format = (v) => String(v), height = 160 }) => {
  if (!data.length) return <p className="sub">Нет данных для графика</p>;
  const max = Math.max(...data.map((d) => d.value), 1);
  const maxIdx = data.reduce((mi, d, i, a) => (d.value > a[mi].value ? i : mi), 0);
  return (
    <div className="bars" style={{ height }}>
      {data.map((d, i) => (
        <div className="bar-col" key={i} title={`${d.label}: ${format(d.value)}`}>
          <span className="bar-v">{d.value ? format(d.value) : ''}</span>
          <div className="bar-track">
            <div className={`bar ${i === maxIdx ? 'hot' : ''}`} style={{ height: `${Math.max(3, (d.value / max) * 100)}%` }} />
          </div>
          <span className="bar-x">{d.label}</span>
        </div>
      ))}
    </div>
  );
};

// ── Pagination ────────────────────────────────────────────
const PaginationBar: React.FC<{
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
const ToastContainer: React.FC<{ toasts: Toast[]; removeToast: (id: number) => void }> = ({ toasts, removeToast }) => (
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
const userStatusBadge = (s: UserStatus, blacklist?: boolean) => {
  if (blacklist || s === 'Banned') return { cls: 'danger', label: 'Заблокирован' };
  if (s === 'Active') return { cls: 'solid', label: 'Активен' };
  if (s === 'Trial') return { cls: 'mute', label: 'Триал' };
  return { cls: 'line', label: 'Истёк' };
};
const keyStatusBadge = (s: KeyStatus) => {
  if (s === 'Active') return { cls: 'solid', label: 'Активен' };
  if (s === 'Banned' || s === 'Blocked') return { cls: 'danger', label: 'Заблокирован' };
  return { cls: 'line', label: 'Истёк' };
};

// ==========================================================
// 3. MODALS
// ==========================================================

const DEVICE_LIMIT_PRESETS = [1, 2, 3, 5, 10, 15, 20];

const clampNumber = (raw: string, min: number, max: number, fallback: number) => {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

type ActionConfig = { title: string; label: string; icon: React.ElementType; type: string; min?: number; max?: number; presets?: number[]; };

const ACTION_MAP: Record<string, ActionConfig> = {
  ADD_BALANCE:        { title: 'Начислить баланс', label: 'Сумма, ₽', icon: ArrowUpRight, type: 'number' },
  SUB_BALANCE:        { title: 'Списать баланс', label: 'Сумма, ₽', icon: ArrowDownLeft, type: 'number' },
  EXTEND_SUB:         { title: 'Продлить подписку', label: 'Дней', icon: Clock, type: 'number' },
  REDUCE_SUB:         { title: 'Уменьшить срок', label: 'Дней', icon: Clock, type: 'number' },
  SET_TRAFFIC:        { title: 'Лимит трафика', label: 'Макс. трафик, ГБ', icon: Database, type: 'number' },
  SET_DEVICES:        { title: 'Лимит устройств', label: 'Устройств (1–20)', icon: Smartphone, type: 'number', min: 1, max: 20, presets: DEVICE_LIMIT_PRESETS },
  BAN:                { title: 'Заблокировать', label: 'Причина', icon: Ban, type: 'text' },
  UNBAN:              { title: 'Разблокировать', label: '', icon: CheckCircle, type: 'text' },
  MASS_ADD_DAYS:      { title: 'Всем добавить дни', label: 'Дней', icon: Calendar, type: 'number' },
  MASS_ADD_BALANCE:   { title: 'Всем начислить', label: 'Сумма, ₽', icon: DollarSign, type: 'number' },
  MASS_BAN:           { title: 'Заблокировать всех', label: 'Причина', icon: Ban, type: 'text' },
  MASS_UNBAN:         { title: 'Разблокировать всех', label: '', icon: CheckCircle, type: 'text' },
  MASS_RESET_TRIAL:   { title: 'Сбросить пробный период', label: '', icon: RefreshCw, type: 'text' },
  MASS_DELETE_KEYS:   { title: 'Удалить все ключи', label: '', icon: Trash2, type: 'text' },
  MASS_SET_PARTNER:   { title: 'Сделать партнёрами', label: 'Процент реферала', icon: UserPlus, type: 'number' },
  MASS_REMOVE_PARTNER:{ title: 'Убрать партнёрство', label: '', icon: UserMinus, type: 'text' },
  SET_PARTNER_RATE:   { title: 'Процент реферала', label: 'Процент, %', icon: Percent, type: 'number', min: 0, max: 100 },
  SET_PARTNER_BALANCE:{ title: 'Реферальный баланс', label: 'Сумма, ₽', icon: Wallet, type: 'number' },
  ADD_PARTNER_BALANCE:{ title: 'Начислить на реф-баланс', label: 'Сумма, ₽', icon: Plus, type: 'number' },
  SUB_PARTNER_BALANCE:{ title: 'Списать с реф-баланса', label: 'Сумма, ₽', icon: ArrowDownLeft, type: 'number' },
  ADD_TRAFFIC:        { title: 'Добавить трафик', label: 'ГБ', icon: Database, type: 'number' },
  SUB_TRAFFIC:        { title: 'Убавить трафик', label: 'ГБ', icon: Database, type: 'number' },
  SET_TELEGRAM_ID:    { title: 'Изменить Telegram ID', label: 'Новый Telegram ID', icon: Edit2, type: 'number' },
  SET_EMAIL:          { title: 'Изменить email', label: 'Новый email', icon: Mail, type: 'text' },
  NOTIFY:             { title: 'Написать пользователю', label: 'Сообщение', icon: Send, type: 'text' },
};

const UserActionModal: React.FC<{
  type: string; onClose: () => void; onConfirm: (value: string, notify: boolean) => void; initialValue?: string;
}> = ({ type, onClose, onConfirm, initialValue = '' }) => {
  const [value, setValue] = useState(initialValue);
  const [notify, setNotify] = useState(true);
  const config = ACTION_MAP[type] || { title: 'Действие', label: 'Значение', icon: Settings, type: 'text' };
  const numMin = config.min ?? 0;
  const numMax = config.max ?? 999999;
  const numValue = config.type === 'number' ? clampNumber(value, numMin, numMax, numMin || 0) : 0;
  const showStepper = config.type === 'number' && (!!config.presets?.length || config.max !== undefined);
  const setNum = (n: number) => setValue(String(Math.max(numMin, Math.min(numMax, n))));
  const isDestructive = /BAN|DELETE|REMOVE|SUB_/.test(type);

  return (
    <Modal
      onClose={onClose} title={config.title} icon={config.icon} width={400} z={70}
      footer={
        <>
          <button className="btn block" onClick={onClose}>Отмена</button>
          <button
            className={`btn block ${isDestructive ? 'danger' : 'solid'}`}
            onClick={() => onConfirm(config.type === 'number' ? String(clampNumber(value, numMin, numMax, numMin || 0)) : value, notify)}
          >Применить</button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {config.label && (
          <div>
            <label className="field-label">{config.label}</label>
            {showStepper ? (
              <div className="flex flex-col gap-3">
                <div className="stepper">
                  <button className="step" onClick={() => setNum(numValue - 1)} disabled={numValue <= numMin}>−</button>
                  <input className="input center mono" style={{ fontSize: 20 }} type="number" value={value}
                    min={numMin} max={numMax} autoFocus onChange={(e) => setValue(e.target.value)} />
                  <button className="step" onClick={() => setNum(numValue + 1)} disabled={numValue >= numMax}>+</button>
                </div>
                {config.presets && (
                  <div className="flex flex-wrap gap-2">
                    {config.presets.map((p) => (
                      <button key={p} className={`chip mono ${numValue === p ? 'on' : ''}`} onClick={() => setNum(p)}>{p}</button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <input className="input mono" type={config.type} value={value} placeholder={config.type === 'number' ? '0' : ''}
                autoFocus min={numMin} max={config.max} onChange={(e) => setValue(e.target.value)} />
            )}
          </div>
        )}
        <label className="inset flex items-center justify-between gap-3" style={{ padding: 12, cursor: 'pointer' }}>
          <div>
            <div style={{ fontWeight: 500 }}>Уведомить пользователя</div>
            <div className="sub">Отправить сообщение в бот</div>
          </div>
          <Toggle on={notify} onChange={() => setNotify(!notify)} />
        </label>
      </div>
    </Modal>
  );
};

const TransactionModal: React.FC<{ transaction: Transaction; onClose: () => void }> = ({ transaction, onClose }) => {
  if (!transaction) return null;
  const isIncome = transaction.type === 'income';
  const Row = ({ icon: Icon, label, children }: { icon: React.ElementType; label: string; children: React.ReactNode }) => (
    <div className="flex justify-between items-center" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <span className="muted flex items-center gap-2"><Icon size={14} /> {label}</span>
      <span>{children}</span>
    </div>
  );
  return (
    <Modal onClose={onClose} title={isIncome ? 'Пополнение баланса' : 'Списание средств'} icon={isIncome ? ArrowUpRight : ArrowDownLeft} width={440}
      footer={<button className="btn block" onClick={onClose}>Закрыть</button>}>
      <div className="sub mb-3">{transaction.date}</div>
      <Row icon={Hash} label="ID"><span className="mono">#{transaction.id}</span></Row>
      <Row icon={Users} label="Пользователь">{transaction.user}</Row>
      <Row icon={DollarSign} label="Сумма"><span style={{ fontWeight: 600, color: isIncome ? 'var(--text)' : 'var(--muted)' }}>{isIncome ? '+' : ''}{transaction.amount} ₽</span></Row>
      <Row icon={CreditCard} label="Метод">{transaction.method}</Row>
      <Row icon={Hash} label="Hash"><span className="mono faint" style={{ fontSize: 12 }}>{transaction.hash || '—'}</span></Row>
    </Modal>
  );
};

// ==========================================================
// 4. MAPPERS
// ==========================================================

function mapApiUser(u: any): User {
  return {
    id: u.id,
    telegramId: u.telegram_id,
    username: u.username ? (String(u.username).startsWith('@') ? u.username : `@${u.username}`) : `id${u.telegram_id}`,
    balance: u.balance ?? 0,
    status: (u.in_blacklist || u.is_banned) ? 'Banned' : ((u.status as UserStatus) || 'Trial'),
    regDate: u.registration_date ? new Date(u.registration_date).toLocaleDateString('ru-RU') : '',
    paidUntil: u.paid_until ? new Date(u.paid_until).toLocaleDateString('ru-RU') : '—',
    refCode: u.referral_code || '',
    isPartner: !!u.is_partner,
    partnerBalance: u.partner_balance ?? 0,
    partnerRate: u.partner_rate ?? 25,
    referrals: u.referrals ?? 0,
    inBlacklist: !!u.in_blacklist,
  };
}

function mapApiKey(k: any): KeyItem {
  return {
    id: k.id,
    key: k.key_config || k.key_uuid || `key_${k.id}`,
    user: k.username || `@user_${k.user_id}`,
    status: (k.status as KeyStatus) || 'Active',
    expiry: k.expiry_date ? Math.ceil((new Date(k.expiry_date).getTime() - Date.now()) / 86_400_000) : 0,
    trafficUsed: k.traffic_used ?? 0,
    trafficLimit: k.traffic_limit ?? 0,
    devicesUsed: k.devices_used ?? 0,
    devicesLimit: k.devices_limit ?? 1,
  };
}

// ==========================================================
// 5. LOGIN
// ==========================================================

function LoginForm({ onLogin }: { onLogin: (token: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [tempToken, setTempToken] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [initInfo, setInitInfo] = useState<{ username?: string; password?: string; newAdmin?: boolean; passwordRegenerated?: boolean; message?: string } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const setupToken = params.get('setup_token') || '';
    const headers: Record<string, string> = {};
    if (setupToken) headers['X-Panel-Setup-Token'] = setupToken;
    const qs = setupToken ? `?setup_token=${encodeURIComponent(setupToken)}` : '';
    fetch(`/api/panel/auth/init${qs}`, { headers })
      .then((r) => r.json())
      .then((data) => {
        if (data.show_credentials && data.password && data.username) {
          setInitInfo({ username: data.username, password: data.password, newAdmin: !!data.new_admin, passwordRegenerated: !!data.password_regenerated, message: data.message });
          setUsername(data.username);
        }
      }).catch(() => {});
  }, []);

  const submitCreds = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setLoading(true);
    try {
      const res = await fetch('/api/panel/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const data = await res.json();
      if (res.ok && data.requires_2fa && data.temp_token) setTempToken(data.temp_token);
      else if (res.ok && data.session_token) { setPanelToken(data.session_token); onLogin(data.session_token); }
      else setError(data.error || 'Неверные учётные данные');
    } catch { setError('Ошибка подключения к серверу'); }
    setLoading(false);
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setLoading(true);
    try {
      const res = await fetch('/api/panel/auth/verify-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ temp_token: tempToken, code: verifyCode }) });
      const data = await res.json();
      if (res.ok && data.session_token) { setPanelToken(data.session_token); onLogin(data.session_token); }
      else setError(data.error || 'Неверный код');
    } catch { setError('Ошибка подключения к серверу'); }
    setLoading(false);
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card-lg rise" style={{ padding: 32, width: '100%', maxWidth: 400, background: 'var(--surface)', border: '1px solid var(--border-strong)' }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div className="avatar" style={{ width: 56, height: 56, borderRadius: 14, margin: '0 auto 14px' }}>
            <img src="/assets/logo.png" alt="BlinVPN" style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 8 }}
              onError={(e) => { const img = e.currentTarget; img.style.display = 'none'; (img.nextElementSibling as HTMLElement | null)?.style.setProperty('display', 'block'); }} />
            <Lock size={26} style={{ display: 'none' }} />
          </div>
          <h1 className="h-page" style={{ fontSize: 22 }}>BlinVPN Panel</h1>
          <p className="sub mt-1">Вход в панель управления</p>
        </div>

        {initInfo?.password && (
          <div className="inset" style={{ padding: 14, marginBottom: 20 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>
              {initInfo.newAdmin ? 'Создан администратор' : initInfo.passwordRegenerated ? 'Пароль сброшен' : 'Данные для входа'}
            </div>
            <div className="sub">Логин: <code className="mono" style={{ color: 'var(--text)', userSelect: 'all' }}>{initInfo.username}</code></div>
            <div className="sub">Пароль: <code className="mono" style={{ color: 'var(--text)', userSelect: 'all', wordBreak: 'break-all' }}>{initInfo.password}</code></div>
            <div className="faint mt-2" style={{ fontSize: 12 }}>{initInfo.message || 'Показывается до первого входа. Сохраните.'}</div>
          </div>
        )}

        {!tempToken ? (
          <form onSubmit={submitCreds} className="flex flex-col gap-4">
            <div><label className="field-label">Логин</label><input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" required /></div>
            <div><label className="field-label">Пароль</label><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required /></div>
            {error && <div className="badge danger" style={{ width: '100%', padding: '10px 12px', justifyContent: 'flex-start' }}>{error}</div>}
            <button className="btn solid block" type="submit" disabled={loading || !username || !password} style={{ padding: 12 }}>
              {loading ? <><Spinner size={18} /> Вход…</> : 'Войти'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode} className="flex flex-col gap-4">
            <div className="inset sub" style={{ padding: 12 }}>Код подтверждения отправлен администраторам в Telegram.</div>
            <div><label className="field-label">Код</label><input className="input mono center" value={verifyCode} onChange={(e) => setVerifyCode(e.target.value)} placeholder="123456" required /></div>
            {error && <div className="badge danger" style={{ width: '100%', padding: '10px 12px', justifyContent: 'flex-start' }}>{error}</div>}
            <button className="btn solid block" type="submit" disabled={loading || !verifyCode} style={{ padding: 12 }}>{loading ? 'Проверка…' : 'Подтвердить'}</button>
          </form>
        )}
      </div>
    </div>
  );
}

// ==========================================================
// 6. ROOT
// ==========================================================

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    const token = getPanelToken();
    if (!token) { setIsAuthenticated(false); return; }
    fetch('/api/panel/stats/summary', { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } })
      .then((res) => { if (res.ok) setIsAuthenticated(true); else { clearPanelToken(); setIsAuthenticated(false); } })
      .catch(() => setIsAuthenticated(false));
  }, []);

  if (isAuthenticated === null) return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner size={36} /></div>;
  if (!isAuthenticated) return <LoginForm onLogin={() => setIsAuthenticated(true)} />;
  return <AuthenticatedApp onLogout={() => { clearPanelToken(); setIsAuthenticated(false); }} />;
}

// ==========================================================
// WITHDRAWALS (выводы реф. средств)
// ==========================================================

type WithdrawalItem = {
  id: number; user_id: number; username?: string | null; telegram_id?: number | null;
  amount: number; address: string; status: 'pending' | 'approved' | 'rejected';
  tx_link?: string | null; created_at?: string; processed_at?: string | null;
};

const WithdrawalsPage: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void; onOpenUser: (id: number) => void }> = ({ onToast, onOpenUser }) => {
  const [items, setItems] = useState<WithdrawalItem[]>([]);
  const [pending, setPending] = useState<{ count: number; amount: number }>({ count: 0, amount: 0 });
  const [loading, setLoading] = useState(true);
  const [approve, setApprove] = useState<WithdrawalItem | null>(null);
  const [txLink, setTxLink] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const d = await apiFetch('/panel/withdrawals');
      setItems(Array.isArray(d?.items) ? d.items : []);
      setPending({ count: Number(d?.pending_count || 0), amount: Number(d?.pending_amount || 0) });
    } catch { onToast('Ошибка', 'Не удалось загрузить выводы', 'error'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const doApprove = async () => {
    if (!approve) return;
    if (!/^https?:\/\//i.test(txLink.trim())) { onToast('Ошибка', 'Укажите ссылку на транзакцию (http/https)', 'error'); return; }
    setBusy(true);
    try {
      await apiFetch(`/panel/withdrawals/${approve.id}/approve`, { method: 'POST', body: JSON.stringify({ tx_link: txLink.trim() }) });
      onToast('Готово', 'Вывод одобрен, пользователь уведомлён', 'success');
      setApprove(null); setTxLink(''); load();
    } catch (e: any) { onToast('Ошибка', parseErr(e, 'Не удалось одобрить'), 'error'); }
    finally { setBusy(false); }
  };
  const doReject = async (w: WithdrawalItem) => {
    if (!confirm('Отклонить заявку? Средства вернутся на баланс пользователя.')) return;
    try {
      await apiFetch(`/panel/withdrawals/${w.id}/reject`, { method: 'POST' });
      onToast('Готово', 'Заявка отклонена, средства возвращены', 'success'); load();
    } catch (e: any) { onToast('Ошибка', parseErr(e, 'Не удалось отклонить'), 'error'); }
  };
  const parseErr = (e: any, fb: string) => { try { const p = JSON.parse(e?.message || ''); return p?.detail?.message || p?.error || fb; } catch { return fb; } };

  const badge = (s: string) => s === 'approved' ? <span className="badge solid">Одобрен</span> : s === 'rejected' ? <span className="badge line">Отклонён</span> : <span className="badge" style={{ background: '#F1872622', color: '#F18726' }}>Ожидает</span>;
  const fmtDate = (s?: string | null) => { if (!s) return '—'; try { return new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return s; } };

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Выводы" sub="Заявки на вывод реферальных средств (USDT TON). Одобрять можно здесь или из форума." />

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="card" style={{ padding: 18 }}><div className="sub">Ожидают</div><div style={{ fontSize: 24, fontWeight: 600 }}>{pending.count}</div></div>
        <div className="card" style={{ padding: 18 }}><div className="sub">Заморожено</div><div style={{ fontSize: 24, fontWeight: 600 }}>{pending.amount}₽</div></div>
      </div>

      <div className="tbl-wrap">
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 className="h-sec">Заявки</h3>
          <button className="btn sm" onClick={load}><RefreshCw size={14} /> Обновить</button>
        </div>
        {loading ? <div className="sub" style={{ padding: 32, textAlign: 'center' }}>Загрузка…</div>
          : items.length === 0 ? <div className="sub" style={{ padding: 32, textAlign: 'center' }}>Заявок пока нет</div>
          : <div style={{ overflowX: 'auto' }}><table className="tbl" style={{ minWidth: 820 }}>
              <thead><tr><th>#</th><th>Пользователь</th><th>Сумма</th><th>Адрес</th><th>Статус</th><th>Дата</th><th style={{ textAlign: 'right' }}>Действия</th></tr></thead>
              <tbody>{items.map((w) => (
                <tr key={w.id}>
                  <td className="muted">{w.id}</td>
                  <td><button className="btn sm" style={{ background: 'transparent', border: 'none', padding: 0, color: '#F18726' }} onClick={() => onOpenUser(w.user_id)}>{w.username ? `@${w.username}` : `id${w.user_id}`}</button></td>
                  <td style={{ fontWeight: 600 }}>{w.amount}₽</td>
                  <td className="mono" style={{ fontSize: 12, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={w.address}>{w.address}</td>
                  <td>{badge(w.status)}</td>
                  <td className="muted" style={{ fontSize: 13 }}>{fmtDate(w.created_at)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {w.status === 'pending'
                      ? <span className="inline-flex gap-2"><button className="btn sm solid" onClick={() => { setApprove(w); setTxLink(''); }}>Одобрить</button><button className="btn sm" onClick={() => doReject(w)}>Отклонить</button></span>
                      : w.tx_link ? <a className="btn sm" href={w.tx_link} target="_blank" rel="noreferrer">Транзакция</a> : <span className="muted">—</span>}
                  </td>
                </tr>
              ))}</tbody>
            </table></div>}
      </div>

      {approve && (
        <Modal onClose={() => setApprove(null)} title={`Одобрить вывод #${approve.id}`} width={460}
          footer={<><button className="btn block" onClick={() => setApprove(null)}>Отмена</button><button className="btn solid block" onClick={doApprove} disabled={busy}>{busy ? <Spinner size={16} /> : 'Одобрить'}</button></>}>
          <div className="flex flex-col gap-3">
            <div className="inset" style={{ padding: 12, fontSize: 13 }}>Пользователь {approve.username ? `@${approve.username}` : `id${approve.user_id}`} · {approve.amount}₽<br /><span className="mono" style={{ fontSize: 12 }}>{approve.address}</span></div>
            <div><label className="field-label">Ссылка на транзакцию</label><input className="input mono" value={txLink} onChange={(e) => setTxLink(e.target.value)} placeholder="https://tonviewer.com/transaction/…" /></div>
            <div className="sub" style={{ fontSize: 12 }}>Пользователь получит это сообщение со ссылкой, а заявка исчезнет из форума.</div>
          </div>
        </Modal>
      )}
    </div>
  );
};

const NAV = [
  { group: 'Главное', items: [{ name: 'Главная', icon: Home }, { name: 'Финансы', icon: DollarSign }, { name: 'Выводы', icon: Wallet }] },
  { group: 'Пользователи', items: [{ name: 'Пользователи', icon: Users }] },
  { group: 'Маркетинг', items: [{ name: 'Рассылка', icon: Mail }, { name: 'Промокоды', icon: Gift }, { name: 'Акции', icon: Percent }, { name: 'Ссылки', icon: Link }, { name: 'Опрос', icon: ClipboardList }] },
  { group: 'Другое', items: [{ name: 'Настройки', icon: Settings }] },
];

function AuthenticatedApp({ onLogout }: { onLogout: () => void }) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [activePage, setActivePage] = useState('Главная');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [detailUserId, setDetailUserId] = useState<number | null>(null);
  const [userSearch, setUserSearch] = useState('');
  const [massActionType, setMassActionType] = useState<string | null>(null);

  const addToast = (title: string, message: string, type: ToastType = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((p) => [...p, { id, title, message, type }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 4000);
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <ToastContainer toasts={toasts} removeToast={(id) => setToasts((p) => p.filter((t) => t.id !== id))} />

      {massActionType && (
        <UserActionModal type={massActionType} onClose={() => setMassActionType(null)} onConfirm={async (val, notify) => {
          try {
            await apiFetch('/panel/users/mass-action', { method: 'POST', body: JSON.stringify({ action: massActionType, value: val, notify }) });
            addToast('Готово', 'Массовое действие выполнено', 'success');
          } catch { addToast('Ошибка', 'Не удалось выполнить действие', 'error'); }
          setMassActionType(null);
        }} />
      )}

      {/* Sidebar */}
      <aside style={{
        position: 'fixed', insetBlock: 0, left: 0, zIndex: 50, width: 250,
        background: 'var(--surface)', borderRight: '1px solid var(--border)',
        transform: isMobileMenuOpen ? 'none' : 'translateX(-100%)', transition: 'transform var(--t)', overflowY: 'auto',
      }} className="md:!translate-x-0">
        <div className="flex items-center gap-3" style={{ padding: 20, borderBottom: '1px solid var(--border)' }}>
          <img src="/assets/logo.png" alt="" style={{ width: 34, height: 34, borderRadius: 8, objectFit: 'contain' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          <div><div className="h-sec">BlinVPN</div><div className="faint" style={{ fontSize: 12 }}>Панель управления</div></div>
        </div>
        <nav style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {NAV.map((section) => (
            <div key={section.group}>
              <div className="nav-group">{section.group}</div>
              <div className="flex flex-col gap-1">
                {section.items.map((item) => (
                  <button key={item.name} className={`nav-item ${activePage === item.name ? 'on' : ''}`}
                    onClick={() => { setActivePage(item.name); setDetailUserId(null); setIsMobileMenuOpen(false); }}>
                    <item.icon size={17} className={activePage === item.name ? '' : 'faint'} /> {item.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <main className="md:!ml-[250px]" style={{ minHeight: '100vh' }}>
        <div style={{ position: 'sticky', top: 0, zIndex: 30, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(10px)', borderBottom: '1px solid var(--border)' }}>
          <button className="icon-btn md:!hidden" onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}>{isMobileMenuOpen ? <X size={20} /> : <Menu size={20} />}</button>
          <div className="flex-1" />
          <button className="icon-btn danger" onClick={onLogout} title="Выход"><Lock size={16} /></button>
        </div>

        <div style={{ padding: 20 }} className="rise">
          {detailUserId != null ? (
            <UserDetailPage userId={detailUserId} onBack={() => setDetailUserId(null)} onToast={addToast} onOpenUser={(id) => setDetailUserId(id)} />
          ) : (
            <>
              {activePage === 'Главная' && <Dashboard />}
              {activePage === 'Финансы' && <FinancePage onToast={addToast} onOpenUser={(id) => setDetailUserId(id)} />}
              {activePage === 'Выводы' && <WithdrawalsPage onToast={addToast} onOpenUser={(id) => setDetailUserId(id)} />}
              {activePage === 'Пользователи' && <UsersPage userSearch={userSearch} setUserSearch={setUserSearch} setSelectedUser={(u) => setDetailUserId(u.id)} setMassActionType={setMassActionType} />}
              {activePage === 'Рассылка' && <MailingPage onToast={addToast} />}
              {activePage === 'Промокоды' && <PromocodesPage onToast={addToast} />}
              {activePage === 'Акции' && <PromotionsPage onToast={addToast} />}
              {activePage === 'Ссылки' && <TrackingLinksPage onToast={addToast} />}
              {activePage === 'Опрос' && <SurveyPage onToast={addToast} onOpenUser={(id) => setDetailUserId(id)} />}
              {activePage === 'Настройки' && <SettingsPage onToast={addToast} />}
            </>
          )}
        </div>
      </main>

      {isMobileMenuOpen && <div onClick={() => setIsMobileMenuOpen(false)} className="md:!hidden" style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,0.5)' }} />}
    </div>
  );
}

// ── page header helper ────────────────────────────────────
const PageHead: React.FC<{ title: string; sub?: string; children?: React.ReactNode }> = ({ title, sub, children }) => (
  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
    <div><h2 className="h-page">{title}</h2>{sub && <p className="sub mt-1">{sub}</p>}</div>
    {children}
  </div>
);

// ==========================================================
// 7. DASHBOARD
// ==========================================================

const Dashboard = () => {
  const [summary, setSummary] = useState<{ total_users: number; active_keys: number; monthly_revenue: number } | null>(null);
  const [stats, setStats] = useState<any>(null);
  const [period, setPeriod] = useState<'week' | 'month' | 'year'>('month');

  useEffect(() => { (async () => { try { const d = await apiFetch('/panel/stats/summary'); if (d) setSummary(d); } catch (e) { console.error(e); } })(); }, []);
  useEffect(() => { (async () => { try { const d = await apiFetch(`/panel/statistics/full?period=${period}`); if (d) setStats(d); } catch (e) { console.error(e); } })(); }, [period]);

  const totalUsers = stats?.totalUsers ?? summary?.total_users;
  const activeSubs = stats?.activeSubscriptions ?? summary?.active_keys;
  const monthlyRevenue = summary?.monthly_revenue;

  const revenueSeries = toSeries(stats?.revenueByDay ?? stats?.dailyRevenue ?? stats?.revenueChart ?? stats?.revenue_by_day ?? stats?.chart);

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Панель управления" sub="Обзор BlinVPN" />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Stat title="Пользователи" value={totalUsers != null ? fmtInt(totalUsers) : '—'} icon={Users} />
        <Stat title="Активные подписки" value={activeSubs != null ? fmtInt(activeSubs) : '—'} icon={Key} />
        <Stat title="Доход за месяц" value={monthlyRevenue != null ? fmtMoneyShort(monthlyRevenue) : '—'} icon={DollarSign} />
        <Stat title="Платежей сегодня" value={stats ? fmtInt(stats.paymentsToday) : '—'} icon={CreditCard} />
        <Stat title="Баланс клиентов" value={stats ? fmtMoneyShort(stats.clientsBalance) : '—'} icon={Wallet} />
      </div>

      {!stats ? (
        <div className="flex items-center justify-center" style={{ height: 200 }}><Spinner size={28} /></div>
      ) : (
        <>
          <div className="card" style={{ padding: 24 }}>
            <div className="flex justify-between items-center mb-5">
              <h3 className="h-sec">Выручка</h3>
              <Segmented value={period} onChange={setPeriod} options={[{ value: 'week', label: 'Неделя' }, { value: 'month', label: '30 дней' }, { value: 'year', label: 'Год' }]} />
            </div>
            {revenueSeries.length > 0 && (
              <div className="mb-6"><BarChart data={revenueSeries} format={(v) => fmtMoneyShort(v)} height={180} /></div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="inset" style={{ padding: 16 }}><div className="sub">В среднем в день</div><div className="stat-value mt-1">{fmtMoneyShort(stats.avgDaily || 0)}</div></div>
              <div className="inset" style={{ padding: 16 }}><div className="sub">Лучший день</div><div className="stat-value mt-1">{fmtMoneyShort(stats.bestDayValue || 0)}</div><div className="faint" style={{ fontSize: 12, marginTop: 2 }}>{stats.bestDayDate || ''}</div></div>
              <div className="inset" style={{ padding: 16 }}><div className="sub">Куплено за неделю</div><div className="stat-value mt-1">+{fmtInt(stats.boughtThisWeek)}</div></div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card" style={{ padding: 24 }}>
              <h3 className="h-sec mb-5">Распределение пользователей</h3>
              <BarChart data={toSeries(stats.userDistData)} format={fmtInt} />
            </div>
            <div className="card" style={{ padding: 24 }}>
              <h3 className="h-sec mb-5">Способы оплаты</h3>
              <BarChart data={toSeries(stats.paymentMethodsData)} format={fmtInt} />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="card" style={{ padding: 24 }}>
              <h3 className="h-sec mb-4">Подписки</h3>
              <div className="flex flex-col gap-3" style={{ fontSize: 14 }}>
                <div className="flex justify-between"><span className="muted">Всего</span><span style={{ fontWeight: 500 }}>{fmtInt(stats.totalSubscriptions)}</span></div>
                <div className="flex justify-between"><span className="muted">Платные</span><span style={{ fontWeight: 500 }}>{fmtInt(stats.paidSubscriptions)}</span></div>
                <div className="flex justify-between"><span className="muted">За неделю</span><span style={{ fontWeight: 500 }}>+{fmtInt(stats.boughtThisWeek)}</span></div>
              </div>
            </div>
            <div className="card" style={{ padding: 24 }}>
              <h3 className="h-sec mb-4">Конверсия trial → paid</h3>
              <div className="stat-value" style={{ fontSize: 36 }}>{stats.conversionRate?.toFixed(1) || 0}%</div>
              <p className="sub mt-2">Переход на платный тариф после пробного периода.</p>
              <div className="hbar mt-4"><i style={{ width: `${Math.min(stats.conversionRate || 0, 100)}%`, background: 'var(--text)' }} /></div>
            </div>
            <div className="card" style={{ padding: 24 }}>
              <h3 className="h-sec mb-4">Рефералы</h3>
              <div className="flex flex-col gap-3" style={{ fontSize: 14 }}>
                <div className="flex justify-between"><span className="muted">Приглашено</span><span style={{ fontWeight: 500 }}>{fmtInt(stats.totalInvited)}</span></div>
                <div className="flex justify-between"><span className="muted">Партнёров</span><span style={{ fontWeight: 500 }}>{fmtInt(stats.partners)}</span></div>
                <div className="flex justify-between"><span className="muted">Выплачено</span><span style={{ fontWeight: 500 }}>{fmtMoneyShort(stats.totalPaid)}</span></div>
              </div>
            </div>
          </div>

          <div className="tbl-wrap">
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}><h3 className="h-sec">Топ рефералов</h3></div>
            <table className="tbl">
              <thead><tr><th>Пользователь</th><th>Пригласил</th><th>Заработал</th></tr></thead>
              <tbody>
                {(stats.topReferrers || []).map((r: any) => (
                  <tr key={r.id}>
                    <td><span className="flex items-center gap-2"><Trophy size={14} className="faint" /> {r.name}</span></td>
                    <td className="muted">{r.count} чел.</td>
                    <td style={{ fontWeight: 500 }}>{fmtMoney(r.earned)}</td>
                  </tr>
                ))}
                {(!stats.topReferrers || stats.topReferrers.length === 0) && <tr className="empty-row"><td colSpan={3}>Нет данных</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};

// ==========================================================
// 8. FINANCE
// ==========================================================

const FinancePage: React.FC<{ onToast: (t: string, m: string, ty?: ToastType) => void; onOpenUser: (id: number) => void }> = ({ onToast, onOpenUser }) => {
  const [stats, setStats] = useState<{ deposits: number; withdrawals: number; successfulOps: number } | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [refBusy, setRefBusy] = useState<string | null>(null);
  const loadPayments = async () => { try { setPayments((await apiFetch('/panel/payments?limit=100')) || []); } catch { /* ignore */ } };
  useEffect(() => { (async () => { try { const d = await apiFetch('/panel/finance/stats'); if (d) setStats(d); } catch (e) { console.error(e); } })(); void loadPayments(); }, []);

  const doRefund = async (pm: PaymentRow) => {
    if (!pm.payment_id || refBusy) return;
    if (!window.confirm(`Вернуть средства по платежу на ${pm.amount} ₽ через Platega?\nПодписка будет отозвана, реферальный бонус аплайна снят.`)) return;
    setRefBusy(String(pm.payment_id));
    try {
      const r = await apiFetch(`/panel/payments/${encodeURIComponent(pm.payment_id)}/refund`, { method: 'POST' });
      if (r && r.ok) onToast('Возврат', (r.message || 'Возврат отправлен') + (r.manual ? ' (ручной контроль)' : ''), 'success');
      else onToast('Возврат', (r && r.message) || 'Не удалось выполнить возврат', 'error');
      await loadPayments();
    } catch (e) { onToast('Ошибка', parseErr(e), 'error'); }
    finally { setRefBusy(null); }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Финансы" sub="Доходы и операции" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Stat title="Пополнения" value={stats ? fmtMoney(stats.deposits) : '—'} icon={ArrowUpRight} />
        <Stat title="Успешные операции" value={stats ? fmtInt(stats.successfulOps) : '—'} sub="операций" icon={Activity} />
      </div>

      <div className="tbl-wrap">
        <div style={{ overflowX: 'auto' }}>
          <div className="sub" style={{ padding: '10px 14px', fontWeight: 600 }}>Платежи и возвраты</div>
          <table className="tbl">
            <thead><tr><th>Дата</th><th>Пользователь</th><th>Сумма</th><th>Описание</th><th>Статус</th><th></th></tr></thead>
            <tbody>
              {payments.length === 0 ? <tr className="empty-row"><td colSpan={6}>Пока нет платежей</td></tr>
                : payments.map((pm) => (
                  <tr key={String(pm.id)}>
                    <td className="muted mono">{fmtDateTime(pm.created_at)}</td>
                    <td className="click" onClick={() => pm.user_id && onOpenUser(Number(pm.user_id))}>{pm.username ? `@${pm.username}` : `id${pm.user_id}`}</td>
                    <td className="mono">
                      {pm.stars ? `${pm.stars} ⭐` : `${pm.amount ?? 0} ${pm.currency || ''}`}
                      {pm.referral_applied ? <span className="sub" style={{ marginLeft: 6 }}>+{pm.referral_applied}₽ реф.</span> : null}
                    </td>
                    <td className="sub">{pm.description || pm.purpose || '—'}<div className="faint" style={{ fontSize: 11 }}>{pm.method || pm.provider || ''}</div></td>
                    <td><span className={`badge ${pm.status === 'paid' || pm.status === 'completed' ? 'solid' : pm.status === 'failed' ? 'danger' : pm.status === 'refunded' ? 'danger' : 'mute'}`}>{pm.status}</span></td>
                    <td>
                      {pm.refundable ? (
                        <button className="btn sm danger" disabled={refBusy === String(pm.payment_id)} onClick={() => void doRefund(pm)}>Возврат</button>
                      ) : pm.refunded_at ? (
                        <span className="sub">возвращён</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

// ==========================================================
// 9. USERS
// ==========================================================

// small hook: close menu on outside click
function useOutside<T extends HTMLElement>(onOutside: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOutside(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onOutside]);
  return ref;
}

const MASS_ACTIONS = [
  { t: 'MASS_ADD_DAYS', icon: Calendar, label: 'Добавить дни всем' },
  { t: 'MASS_ADD_BALANCE', icon: DollarSign, label: 'Начислить баланс всем' },
  { t: 'MASS_BAN', icon: Ban, label: 'Заблокировать всех' },
  { t: 'MASS_UNBAN', icon: CheckCircle, label: 'Разблокировать всех' },
  { t: 'MASS_RESET_TRIAL', icon: RefreshCw, label: 'Сбросить пробный период' },
  { t: 'MASS_DELETE_KEYS', icon: Trash2, label: 'Удалить все ключи' },
  { t: 'MASS_SET_PARTNER', icon: UserPlus, label: 'Сделать партнёрами' },
  { t: 'MASS_REMOVE_PARTNER', icon: UserMinus, label: 'Убрать партнёрство' },
];

const UsersPage: React.FC<{
  userSearch: string; setUserSearch: (s: string) => void; setSelectedUser: (u: User) => void; setMassActionType: (t: string | null) => void;
}> = ({ userSearch, setUserSearch, setSelectedUser, setMassActionType }) => {
  const [statusFilter, setStatusFilter] = useState<'all' | 'Trial' | 'Active' | 'Banned'>('all');
  const [showFilter, setShowFilter] = useState(false);
  const [showMass, setShowMass] = useState(false);
  const massRef = useOutside<HTMLDivElement>(() => setShowMass(false));
  const filterRef = useOutside<HTMLDivElement>(() => setShowFilter(false));

  const { items: users, total, page, totalPages, loading, error, nextPage, prevPage } = usePaginatedList({
    basePath: '/panel/users', search: userSearch,
    extraParams: { status: statusFilter === 'all' ? undefined : statusFilter },
    mapItem: mapApiUser,
    clientFilter: (u: User) => statusFilter === 'all' ? true : statusFilter === 'Banned' ? u.status === 'Banned' : u.status === statusFilter,
  });

  const filterLabels: Record<string, string> = { all: 'Все', Trial: 'Триал', Active: 'Активные', Banned: 'Заблок.' };

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Пользователи" sub="База клиентов">
        <div style={{ position: 'relative' }} ref={massRef}>
          <button className="btn solid" onClick={() => setShowMass(!showMass)}><Layers size={16} /> Массовые действия <ChevronDown size={15} style={{ transform: showMass ? 'rotate(180deg)' : 'none', transition: 'transform var(--t)' }} /></button>
          {showMass && (
            <div className="menu" style={{ right: 0 }}>
              {MASS_ACTIONS.map((a) => (
                <button key={a.t} className="menu-item" onClick={() => { setMassActionType(a.t); setShowMass(false); }}><a.icon size={15} className="faint" /> {a.label}</button>
              ))}
            </div>
          )}
        </div>
      </PageHead>

      <div className="flex gap-3">
        <div className="search flex-1">
          <Search className="ico" size={16} />
          <input className="input" value={userSearch} onChange={(e) => setUserSearch(e.target.value)} placeholder="Имя, username или ID…" />
        </div>
        <div style={{ position: 'relative' }} ref={filterRef}>
          <button className={`btn ${statusFilter !== 'all' ? 'solid' : ''}`} onClick={() => setShowFilter(!showFilter)}><Filter size={16} /> {filterLabels[statusFilter]}</button>
          {showFilter && (
            <div className="menu" style={{ right: 0, minWidth: 160 }}>
              {(['all', 'Trial', 'Active', 'Banned'] as const).map((v) => (
                <button key={v} className="menu-item" onClick={() => { setStatusFilter(v); setShowFilter(false); }}>{filterLabels[v]}</button>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && <div className="badge danger" style={{ width: '100%', padding: '10px 14px', justifyContent: 'flex-start' }}>{error}</div>}

      <div className="tbl-wrap">
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>Пользователь</th><th>Баланс</th><th>Подписка</th><th>Статус</th><th style={{ textAlign: 'right' }}></th></tr></thead>
            <tbody>
              {loading && users.length === 0 ? <tr className="empty-row"><td colSpan={5}><Spinner size={18} className="inline-block mr-2" />Загрузка…</td></tr>
                : users.length === 0 ? <tr className="empty-row"><td colSpan={5}>Ничего не найдено</td></tr>
                : users.map((user: User) => {
                    const st = userStatusBadge(user.status, user.inBlacklist);
                    return (
                      <tr key={user.id} className="click" onClick={() => setSelectedUser(user)}>
                        <td><span className="flex items-center gap-3"><span className="avatar" style={{ width: 32, height: 32, fontSize: 12 }}>{user.username.replace('@', '').slice(0, 2).toUpperCase()}</span><span style={{ fontWeight: 500 }}>{user.username}</span></span></td>
                        <td style={{ fontWeight: 600 }}>{user.balance} ₽</td>
                        <td className="muted">{user.paidUntil}</td>
                        <td><span className={`badge ${st.cls}`}>{st.label}</span>{user.isPartner && <span className="badge mute" style={{ marginLeft: 6 }}>Партнёр</span>}</td>
                        <td style={{ textAlign: 'right' }}><span className="icon-btn" style={{ display: 'inline-flex' }}><Settings size={15} /></span></td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
      </div>

      <PaginationBar page={page} totalPages={totalPages} total={total} loading={loading} onPrev={prevPage} onNext={nextPage} />
    </div>
  );
};

// ==========================================================
// 10. USER DETAIL PAGE
// ==========================================================

interface UserDetailData {
  id: number; telegram_id: number | null; username: string | null;
  first_name: string | null; last_name: string | null; email: string | null;
  registration_date: string | null; status: string; is_banned: boolean; key_blocked?: boolean; frozen?: boolean;
  balance: number; partner_rate: number;
  partner_balance: number; is_partner: boolean; has_trial: boolean;
  referrals: { id: number; telegram_id: number | null; username: string | null; email: string | null; full_name: string | null }[];
  subscription: any | null;
  discount?: { percent: number; expires_at: string | null; code: string | null; name: string | null } | null;
  promo_activations?: { id: number; code: string | null; name: string | null; discount_percent: number; expires_at: string | null; created_at: string | null; active: boolean }[];
}
interface UserSurveyAnswer { n: number; q: string; answers: string[]; }
interface UserSurvey { taken: boolean; completed?: boolean; started_at?: string | null; completed_at?: string | null; answers: UserSurveyAnswer[]; }
interface PaymentRow { id: any; payment_id?: string | null; user_id?: number | null; username?: string | null; telegram_id?: number | null; provider: string | null; method: string | null; amount: number | null; currency: string | null; stars: number | null; status: string | null; purpose: string | null; description?: string | null; created_at: string | null; paid_at: string | null; refundable?: boolean; refunded_at?: string | null; referral_applied?: number | null; }
interface RwDevice { hwid: string; platform: string | null; os_version: string | null; device_model: string | null; user_agent: string | null; created_at: string | null; updated_at: string | null; }
interface RwInfo { configured: boolean; found: boolean; online_at: string | null; first_connected_at: string | null; last_user_agent: string | null; status: string | null; used_traffic_bytes: number | null; traffic_limit_bytes: number | null; expire_at: string | null; hwid_device_limit: number | null; subscription_url: string | null; devices: RwDevice[]; error: string | null; }

const STATUS_META: Record<string, { label: string; cls: string }> = {
  trial:   { label: 'Пробная подписка', cls: 'mute' },
  active:  { label: 'Платная подписка', cls: 'solid' },
  expired: { label: 'Истекла', cls: 'line' },
  lapsed:  { label: 'Истекла', cls: 'line' },
  never:   { label: 'Никогда не было подписки', cls: 'line' },
  banned:  { label: 'Заблокирован', cls: 'danger' },
  blocked: { label: 'Ключ заблокирован', cls: 'danger' },
  frozen:  { label: 'Заморожена', cls: 'line' },
};

const fmtDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const relTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso); if (isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  if (diff < 90 * 1000) return 'сейчас онлайн';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  return fmtDateTime(iso);
};

const parseErr = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  try { const j = JSON.parse(msg); return j.detail || j.error || msg; } catch { return msg; }
};

const InfoRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center justify-between gap-3" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
    <span className="sub" style={{ minWidth: 140 }}>{label}</span>
    <span className="flex items-center gap-2" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>{children}</span>
  </div>
);

const DCard: React.FC<{ title?: React.ReactNode; icon?: React.ElementType; children: React.ReactNode; actions?: React.ReactNode }> = ({ title, icon: Icon, children, actions }) => (
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

const UserDetailPage: React.FC<{
  userId: number; onBack: () => void; onToast: (t: string, m: string, ty?: ToastType) => void; onOpenUser: (id: number) => void;
}> = ({ userId, onBack, onToast, onOpenUser }) => {
  const [detail, setDetail] = useState<UserDetailData | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [rw, setRw] = useState<RwInfo | null>(null);
  const [survey, setSurvey] = useState<UserSurvey | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [editTg, setEditTg] = useState(false);
  const [editEmail, setEditEmail] = useState(false);
  const [tgDraft, setTgDraft] = useState('');
  const [emailDraft, setEmailDraft] = useState('');
  const [promoDraft, setPromoDraft] = useState('');

  const load = async () => {
    try { setDetail(await apiFetch(`/panel/users/${userId}/detail`)); }
    catch (e) { onToast('Ошибка', parseErr(e), 'error'); }
    finally { setLoading(false); }
  };
  const loadPayments = async () => { try { setPayments((await apiFetch(`/panel/users/${userId}/payments`)) || []); } catch { /* ignore */ } };
  const loadRw = async () => { try { setRw(await apiFetch(`/panel/users/${userId}/remnawave`)); } catch { /* ignore */ } };
  const loadSurvey = async () => { try { setSurvey(await apiFetch(`/panel/users/${userId}/survey`)); } catch { /* ignore */ } };

  const doRefund = async (pm: PaymentRow) => {
    if (!pm.payment_id || busy) return;
    if (!window.confirm(`Вернуть средства по платежу на ${pm.amount} ₽ через Platega?\nПодписка будет отозвана, реферальный бонус аплайна снят.`)) return;
    setBusy(true);
    try {
      const r = await apiFetch(`/panel/payments/${encodeURIComponent(pm.payment_id)}/refund`, { method: 'POST' });
      if (r && r.ok) onToast('Возврат', (r.message || 'Возврат отправлен') + (r.manual ? ' (ручной контроль)' : ''), 'success');
      else onToast('Возврат', (r && r.message) || 'Не удалось выполнить возврат', 'error');
      await loadPayments(); await load();
    } catch (e) { onToast('Ошибка', parseErr(e), 'error'); }
    finally { setBusy(false); }
  };

  useEffect(() => { setLoading(true); setRw(null); setSurvey(null); void load(); void loadPayments(); void loadRw(); void loadSurvey(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [userId]);

  const doAction = async (act: string, value: any = null, notify = false, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/panel/users/${userId}/action`, { method: 'POST', body: JSON.stringify({ action: act, value, notify }) });
      if (res && res.deleted) { onToast('Готово', 'Аккаунт удалён', 'success'); onBack(); return; }
      onToast('Готово', 'Действие выполнено', 'success');
      await load(); await loadPayments(); await loadRw();
    } catch (e) { onToast('Ошибка', parseErr(e), 'error'); }
    finally { setBusy(false); }
  };

  const unlinkDevice = async (hwid: string) => {
    if (!window.confirm('Отвязать это устройство?')) return;
    try { await apiFetch(`/panel/users/${userId}/hwid/unlink`, { method: 'POST', body: JSON.stringify({ hwid }) }); onToast('Готово', 'Устройство отвязано', 'success'); await loadRw(); }
    catch (e) { onToast('Ошибка', parseErr(e), 'error'); }
  };

  const unlinkReferral = async (refId: number) => {
    try { await apiFetch(`/panel/users/${userId}/referrals/${refId}/unlink`, { method: 'POST' }); onToast('Готово', 'Реферал отвязан', 'success'); await load(); }
    catch (e) { onToast('Ошибка', parseErr(e), 'error'); }
  };

  if (loading) return <div className="center" style={{ padding: 60 }}><Spinner size={22} /></div>;
  if (!detail) return (
    <div className="flex flex-col gap-4">
      <button className="btn" onClick={onBack}><ArrowLeft size={16} /> Назад</button>
      <div className="muted">Пользователь не найден.</div>
    </div>
  );

  const uname = detail.username ? `@${detail.username}` : (detail.telegram_id ? `id${detail.telegram_id}` : `#${detail.id}`);
  const stMeta = detail.key_blocked ? STATUS_META.blocked : detail.is_banned ? STATUS_META.banned : (STATUS_META[detail.status] || STATUS_META.never);
  const sub = detail.subscription;
  const fullName = [detail.first_name, detail.last_name].filter(Boolean).join(' ');

  return (
    <div className="flex flex-col gap-5">
      {action && (
        <UserActionModal type={action} onClose={() => setAction(null)}
          onConfirm={(value, notify) => { const a = action; setAction(null); void doAction(a, value, notify); }} />
      )}

      <div className="flex items-center justify-between gap-3">
        <button className="btn" onClick={onBack}><ArrowLeft size={16} /> К пользователям</button>
        <div className="flex items-center gap-2">
          {detail.frozen
            ? <button className="btn" disabled={busy} onClick={() => void doAction('UNFREEZE', null, false, 'Разморозить подписку? Срок продлится на замороженные дни.')}><CheckCircle size={15} /> Разморозить</button>
            : <button className="btn" disabled={busy} onClick={() => void doAction('FREEZE', null, false, 'Заморозить подписку? Отсчёт дней остановится, VPN отключится.')}><Snowflake size={15} /> Заморозить</button>}
          {detail.key_blocked
            ? <button className="btn" disabled={busy} onClick={() => void doAction('UNBLOCK_KEY', null, false)}><CheckCircle size={15} /> Разблокировать ключ</button>
            : <button className="btn danger" disabled={busy} onClick={() => void doAction('BLOCK_KEY', null, false, 'Заблокировать ключ (подписку) пользователя?')}><Ban size={15} /> Заблокировать ключ</button>}
          <button className="btn danger" disabled={busy} onClick={() => void doAction('DELETE_USER', null, false, 'Удалить аккаунт безвозвратно из базы и Remnawave?')}><Trash2 size={15} /> Удалить</button>
        </div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <div className="flex items-center gap-3">
          <span className="avatar" style={{ width: 48, height: 48, fontSize: 16 }}>{uname.replace('@', '').slice(0, 2).toUpperCase()}</span>
          <div className="flex-1">
            <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
              <span className="h-sec" style={{ fontSize: 18 }}>{uname}</span>
              <span className={`badge ${stMeta.cls}`}>{stMeta.label}</span>
              {detail.is_partner && <span className="badge mute">Партнёр</span>}
            </div>
            {fullName && <div className="sub">{fullName}</div>}
          </div>
          <button className="btn solid" onClick={() => setAction('NOTIFY')}><Send size={15} /> Написать</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <DCard title="Профиль" icon={Hash}>
          <InfoRow label="Внутренний ID"><span className="mono">{detail.id}</span></InfoRow>
          <InfoRow label="Telegram ID">
            {editTg ? (
              <>
                <input className="input mono sm" style={{ width: 150 }} value={tgDraft} onChange={(e) => setTgDraft(e.target.value)} placeholder="123456789" />
                <button className="icon-btn" title="Сохранить" onClick={async () => { await doAction('SET_TELEGRAM_ID', tgDraft); setEditTg(false); }}><Save size={15} /></button>
                <button className="icon-btn" title="Отмена" onClick={() => setEditTg(false)}><X size={15} /></button>
              </>
            ) : (
              <>
                <span className="mono">{detail.telegram_id ?? '—'}</span>
                <button className="icon-btn" title={detail.telegram_id ? 'Изменить' : 'Привязать'} onClick={() => { setTgDraft(String(detail.telegram_id ?? '')); setEditTg(true); }}><Edit2 size={14} /></button>
                {detail.telegram_id && detail.email && <button className="btn sm danger" onClick={() => void doAction('UNBIND_TELEGRAM', null, false, 'Отвязать Telegram от аккаунта?')}>Отвязать</button>}
              </>
            )}
          </InfoRow>
          <InfoRow label="Email">
            {editEmail ? (
              <>
                <input className="input mono sm" style={{ width: 190 }} value={emailDraft} onChange={(e) => setEmailDraft(e.target.value)} placeholder="user@mail.com" />
                <button className="icon-btn" title="Сохранить" onClick={async () => { await doAction('SET_EMAIL', emailDraft); setEditEmail(false); }}><Save size={15} /></button>
                <button className="icon-btn" title="Отмена" onClick={() => setEditEmail(false)}><X size={15} /></button>
              </>
            ) : (
              <>
                <span className="mono">{detail.email ?? '—'}</span>
                <button className="icon-btn" title={detail.email ? 'Изменить' : 'Привязать'} onClick={() => { setEmailDraft(detail.email ?? ''); setEditEmail(true); }}><Edit2 size={14} /></button>
                {detail.email && detail.telegram_id && <button className="btn sm danger" onClick={() => void doAction('UNBIND_EMAIL', null, false, 'Отвязать email от аккаунта?')}>Отвязать</button>}
              </>
            )}
          </InfoRow>
          <InfoRow label="Регистрация"><span className="mono">{fmtDateTime(detail.registration_date)}</span></InfoRow>
          <InfoRow label="Статус"><span className={`badge ${stMeta.cls}`}>{stMeta.label}</span></InfoRow>
          <div className="flex gap-2 mt-3">
            <button className="btn sm" disabled={!detail.has_trial} onClick={() => void doAction('RESET_TRIAL', null, false, 'Сбросить пробный период? Пользователь сможет активировать его заново.')}><RefreshCw size={14} /> Сбросить триал</button>
          </div>
        </DCard>

        <DCard title="Реферальная программа" icon={Percent}>
          <InfoRow label="Процент реферала"><span className="mono">{detail.partner_rate}%</span><button className="icon-btn" title="Изменить" onClick={() => setAction('SET_PARTNER_RATE')}><Edit2 size={14} /></button></InfoRow>
          <InfoRow label="Реферальный баланс">
            <span className="mono">{detail.partner_balance} ₽</span>
            <button className="icon-btn" title="Начислить" onClick={() => setAction('ADD_PARTNER_BALANCE')}><Plus size={14} /></button>
            <button className="icon-btn" title="Списать" onClick={() => setAction('SUB_PARTNER_BALANCE')}><ArrowDownLeft size={14} /></button>
            <button className="icon-btn" title="Установить" onClick={() => setAction('SET_PARTNER_BALANCE')}><Wallet size={14} /></button>
          </InfoRow>
          <div className="mt-3">
            <div className="sub mb-2">Рефералы ({detail.referrals.length})</div>
            {detail.referrals.length === 0 ? <div className="muted sm">Нет рефералов</div> : (
              <div className="flex flex-col gap-1">
                {detail.referrals.map((r) => (
                  <div key={r.id} className="inset flex items-center justify-between" style={{ padding: '8px 10px' }}>
                    <button className="btn sm" style={{ background: 'transparent', border: 'none', padding: 0 }} onClick={() => onOpenUser(r.id)}>{r.username ? `@${r.username}` : (r.telegram_id ? `id${r.telegram_id}` : `#${r.id}`)}</button>
                    <button className="icon-btn danger" title="Отвязать" onClick={() => void unlinkReferral(r.id)}><X size={14} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DCard>
      </div>

      <DCard title="Скидка / Промокод" icon={Gift}>
        {detail.discount ? (
          <InfoRow label="Активная скидка">
            <span style={{ fontWeight: 700, color: 'var(--accent, #F18726)' }}>{detail.discount.percent}%</span>
            <span className="sub">{detail.discount.code}{detail.discount.name ? ` · ${detail.discount.name}` : ''}</span>
            <span className="sub">до {fmtDateTime(detail.discount.expires_at)}</span>
            <button className="btn sm danger" disabled={busy} onClick={() => void doAction('REMOVE_PROMO', detail.discount?.code || null, false, 'Снять скидку у пользователя?')}>Снять</button>
          </InfoRow>
        ) : (
          <div className="muted sm" style={{ marginBottom: 10 }}>Активной скидки нет.</div>
        )}
        <div className="flex items-center gap-2 mt-3" style={{ flexWrap: 'wrap' }}>
          <input className="input mono sm" style={{ width: 170 }} value={promoDraft} onChange={(e) => setPromoDraft(e.target.value.toUpperCase())} placeholder="ПРОМОКОД" />
          <button className="btn sm solid" disabled={busy || !promoDraft.trim()} onClick={async () => { await doAction('APPLY_PROMO', promoDraft.trim()); setPromoDraft(''); }}>Выдать промокод</button>
        </div>
        {detail.promo_activations && detail.promo_activations.length > 0 && (
          <div className="mt-3">
            <div className="sub mb-2">История активаций</div>
            <div className="flex flex-col gap-1">
              {detail.promo_activations.map((a) => (
                <div key={a.id} className="inset flex items-center justify-between" style={{ padding: '8px 10px' }}>
                  <span className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
                    <span className="mono">{a.code}</span>
                    <span style={{ fontWeight: 600 }}>{a.discount_percent}%</span>
                    <span className={`badge ${a.active ? 'solid' : 'line'}`}>{a.active ? 'активна' : 'истекла'}</span>
                    <span className="sub">до {fmtDateTime(a.expires_at)}</span>
                  </span>
                  {a.active && <button className="icon-btn danger" title="Снять" disabled={busy} onClick={() => void doAction('REMOVE_PROMO', a.code || null)}><X size={14} /></button>}
                </div>
              ))}
            </div>
          </div>
        )}
      </DCard>

      <DCard title="Подписка" icon={Key}>
        {!sub ? <div className="muted sm">Активной подписки нет.</div> : (
          <>
            <InfoRow label="Действует до">
              <span className="mono">{fmtDateTime(sub.expiry_date)}</span>
              {typeof sub.days_left === 'number' && <span className="sub">({sub.days_left} дн.)</span>}
            </InfoRow>
            <InfoRow label="Срок">
              <button className="btn sm solid" onClick={() => setAction('EXTEND_SUB')}><Plus size={14} /> Продлить</button>
              <button className="btn sm" onClick={() => setAction('REDUCE_SUB')}>Уменьшить</button>
            </InfoRow>
            <InfoRow label="Трафик (ГБ)">
              <span className="mono">{sub.traffic_used ?? 0} / {sub.traffic_limit ? sub.traffic_limit : '∞'}</span>
              <button className="icon-btn" title="Добавить" onClick={() => setAction('ADD_TRAFFIC')}><Plus size={14} /></button>
              <button className="icon-btn" title="Убавить" onClick={() => setAction('SUB_TRAFFIC')}><ArrowDownLeft size={14} /></button>
              <button className="icon-btn" title="Установить лимит" onClick={() => setAction('SET_TRAFFIC')}><Database size={14} /></button>
            </InfoRow>
            <InfoRow label="Устройств"><span className="mono">{sub.devices_used ?? 0} / {sub.devices_limit ?? 1}</span><button className="icon-btn" title="Изменить лимит" onClick={() => setAction('SET_DEVICES')}><Edit2 size={14} /></button></InfoRow>
          </>
        )}
      </DCard>

      <DCard title="Remnawave" icon={Shield}>
        {!rw ? <div className="center" style={{ padding: 20 }}><Spinner size={18} /></div>
          : !rw.configured ? <div className="muted sm">Remnawave не настроена.</div>
          : !rw.found ? <div className="muted sm">Пользователь не найден в Remnawave.</div>
          : (
          <>
            <InfoRow label="Онлайн / последний вход"><span>{rw.online_at ? relTime(rw.online_at) : '—'}</span></InfoRow>
            <InfoRow label="Первое подключение"><span className="mono">{fmtDateTime(rw.first_connected_at)}</span></InfoRow>
            {rw.last_user_agent && <InfoRow label="Клиент"><span className="sub" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rw.last_user_agent}</span></InfoRow>}
            <div className="mt-3">
              <div className="sub mb-2">Устройства ({rw.devices.length}{rw.hwid_device_limit ? ` / ${rw.hwid_device_limit}` : ''})</div>
              {rw.devices.length === 0 ? <div className="muted sm">Нет привязанных устройств</div> : (
                <div className="flex flex-col gap-1">
                  {rw.devices.map((d) => (
                    <div key={d.hwid} className="inset flex items-center justify-between gap-2" style={{ padding: '8px 10px' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 500 }}>{[d.platform, d.device_model].filter(Boolean).join(' · ') || 'Устройство'}</div>
                        <div className="sub mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }}>{d.hwid}</div>
                      </div>
                      <button className="icon-btn danger" title="Отвязать" onClick={() => void unlinkDevice(d.hwid)}><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {rw.error && <div className="sub" style={{ marginTop: 8 }}>{rw.error}</div>}
          </>
        )}
      </DCard>

      <DCard title="История платежей" icon={CreditCard}>
        {payments.length === 0 ? <div className="muted sm">Платежей нет.</div> : (
          <div className="tbl-wrap"><div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Дата</th><th>Провайдер</th><th>Сумма</th><th>Назначение</th><th>Статус</th><th></th></tr></thead>
              <tbody>
                {payments.map((pm) => (
                  <tr key={String(pm.id)}>
                    <td className="muted mono">{fmtDateTime(pm.created_at)}</td>
                    <td>{pm.provider || '—'}</td>
                    <td className="mono">
                      {pm.stars ? `${pm.stars} ⭐` : `${pm.amount ?? 0} ${pm.currency || ''}`}
                      {pm.referral_applied ? <span className="sub" style={{ marginLeft: 6 }}>+{pm.referral_applied}₽ реф.</span> : null}
                    </td>
                    <td className="sub">{pm.description || pm.purpose || '—'}</td>
                    <td><span className={`badge ${pm.status === 'paid' || pm.status === 'completed' ? 'solid' : pm.status === 'failed' ? 'danger' : pm.status === 'refunded' ? 'danger' : 'mute'}`}>{pm.status}</span></td>
                    <td>
                      {pm.refundable ? (
                        <button className="btn sm danger" disabled={busy} onClick={() => void doRefund(pm)}>Возврат</button>
                      ) : pm.refunded_at ? (
                        <span className="sub">возвращён</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></div>
        )}
      </DCard>

      {survey && survey.taken && (
        <DCard title="Опрос" icon={ClipboardList}>
          <InfoRow label="Статус">
            <span className={`badge ${survey.completed ? 'solid' : 'mute'}`}>{survey.completed ? 'пройден' : 'начат, не завершён'}</span>
          </InfoRow>
          {survey.completed_at && <InfoRow label="Пройден"><span className="mono">{fmtDateTime(survey.completed_at)}</span></InfoRow>}
          <div className="mt-3 flex flex-col gap-2">
            {survey.answers.filter((a) => a.answers.length > 0).map((a) => (
              <div key={a.n} className="inset" style={{ padding: '8px 10px' }}>
                <div className="sub" style={{ marginBottom: 2 }}>{a.n}. {a.q}</div>
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{a.answers.join(', ')}</div>
              </div>
            ))}
          </div>
        </DCard>
      )}
    </div>
  );
};


// ==========================================================
// 10b. SURVEY (опрос)
// ==========================================================

type SurveyOption = { answer: string; count: number };
type SurveyTextAnswer = { answer: string; user_id: number; username?: string | null; telegram_id?: number | null; created_at?: string | null };
type SurveyQuestion = { n: number; q: string; kind: string; options?: SurveyOption[]; answers?: SurveyTextAnswer[] };
type SurveyStats = { total_started: number; total_completed: number; total_invited: number; reward_percent: number; questions: SurveyQuestion[] };

const SurveyBar: React.FC<{ label: string; count: number; max: number; total: number }> = ({ label, count, max, total }) => {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const width = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div style={{ padding: '7px 0' }}>
      <div className="flex items-center justify-between gap-3" style={{ marginBottom: 4 }}>
        <span className="sub" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span className="mono" style={{ whiteSpace: 'nowrap' }}>{count} <span className="faint" style={{ fontSize: 12 }}>· {pct}%</span></span>
      </div>
      <div style={{ height: 8, borderRadius: 6, background: 'var(--border)', overflow: 'hidden' }}>
        <div style={{ width: `${width}%`, height: '100%', background: 'var(--accent, #10b981)', borderRadius: 6 }} />
      </div>
    </div>
  );
};

const SurveyPage: React.FC<{ onToast: (t: string, m: string, ty?: ToastType) => void; onOpenUser: (id: number) => void }> = ({ onToast, onOpenUser }) => {
  const [stats, setStats] = useState<SurveyStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { (async () => {
    try { setStats(await apiFetch('/panel/surveys/stats')); }
    catch (e) { onToast('Ошибка', parseErr(e), 'error'); }
    finally { setLoading(false); }
  })(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  if (loading) return <div className="center" style={{ padding: 60 }}><Spinner size={22} /></div>;
  if (!stats) return <div className="muted" style={{ padding: 20 }}>Нет данных.</div>;

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Опрос" sub={`Награда за прохождение — скидка ${stats.reward_percent}% (суммируется с другими)`} />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Stat title="Приглашено" value={fmtInt(stats.total_invited)} icon={Send} />
        <Stat title="Начали" value={fmtInt(stats.total_started)} icon={ClipboardList} />
        <Stat title="Завершили" value={fmtInt(stats.total_completed)} icon={CheckCircle} sub={stats.total_started ? `${Math.round((stats.total_completed / stats.total_started) * 100)}% из начавших` : undefined} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {stats.questions.map((q) => (
          <DCard key={q.n} title={`${q.n}. ${q.q}`} icon={q.kind === 'text' ? FileText : BarChart2}>
            {q.kind === 'text' ? (
              (q.answers && q.answers.length > 0) ? (
                <div className="flex flex-col gap-2" style={{ maxHeight: 320, overflowY: 'auto' }}>
                  {q.answers.map((a, i) => (
                    <div key={i} className="inset" style={{ padding: '8px 10px' }}>
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{a.answer}</div>
                      <button className="sub" style={{ marginTop: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent, #10b981)' }}
                        onClick={() => onOpenUser(a.user_id)}>
                        {a.username ? `@${a.username}` : (a.telegram_id ? `id${a.telegram_id}` : `#${a.user_id}`)}
                      </button>
                    </div>
                  ))}
                </div>
              ) : <div className="muted sm">Пока нет ответов.</div>
            ) : (
              (q.options && q.options.length > 0) ? (
                <div>
                  {(() => { const max = Math.max(...q.options!.map((o) => o.count), 1); return q.options!.map((o) => (
                    <SurveyBar key={o.answer} label={o.answer} count={o.count} max={max} total={stats.total_completed} />
                  )); })()}
                </div>
              ) : <div className="muted sm">Пока нет ответов.</div>
            )}
          </DCard>
        ))}
      </div>
    </div>
  );
};


// ==========================================================
// 11. MAILING
// ==========================================================

const MailingPage: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [stats, setStats] = useState<{ totalSent: number } | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [message, setMessage] = useState('');
  const [buttonType, setButtonType] = useState('');
  const [buttonLabel, setButtonLabel] = useState('');
  const [buttonUrl, setButtonUrl] = useState('');
  const [promoCode, setPromoCode] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [targetUsers, setTargetUsers] = useState('all');
  const [chTelegram, setChTelegram] = useState(true);
  const [chEmail, setChEmail] = useState(false);
  const [subject, setSubject] = useState('');
  const [isSending, setIsSending] = useState(false);

  const loadHistory = async () => { try { const d = await apiFetch('/panel/mailing/history'); if (Array.isArray(d)) setHistory(d); } catch (e) { console.error(e); } };
  const loadStats = async () => { try { const d = await apiFetch('/panel/mailing/stats'); if (d) setStats(d); } catch (e) { console.error(e); } };

  useEffect(() => { loadStats(); loadHistory(); }, []);
  useEffect(() => {
    if (!history.some((i) => i.status === 'Sending')) return;
    const timer = setInterval(() => { loadHistory(); loadStats(); }, 4000);
    return () => clearInterval(timer);
  }, [history]);

  const handleSend = async () => {
    if (!message.trim()) { onToast('Ошибка', 'Введите текст сообщения', 'error'); return; }
    if ((buttonType === 'external_link' || buttonType === 'open_miniapp') && (!buttonLabel.trim() || !buttonUrl.trim())) { onToast('Ошибка', 'Укажите текст кнопки и ссылку', 'error'); return; }
    if (buttonType === 'activate_promo' && !promoCode.trim()) { onToast('Ошибка', 'Укажите промокод', 'error'); return; }
    const channels = [chTelegram && 'telegram', chEmail && 'email'].filter(Boolean) as string[];
    if (channels.length === 0) { onToast('Ошибка', 'Выберите хотя бы один канал', 'error'); return; }
    if (chEmail && !subject.trim()) { onToast('Ошибка', 'Укажите тему письма для email-рассылки', 'error'); return; }
    if (!confirm('Запустить рассылку?')) return;
    setIsSending(true);
    try {
      const payload: any = { message, target_users: targetUsers, title: message.substring(0, 50), channels };
      if (chEmail) payload.subject = subject.trim();
      if (buttonType === 'external_link' || buttonType === 'open_miniapp') { payload.button_type = buttonType; payload.button_value = `${buttonLabel.trim()}|${buttonUrl.trim()}`; }
      else if (buttonType === 'activate_promo') { payload.button_type = buttonType; payload.button_value = promoCode.trim(); }
      if (imageUrl.trim()) payload.image_url = imageUrl.trim();
      await apiFetch('/panel/mailing', { method: 'POST', body: JSON.stringify(payload) });
      onToast('Рассылка', 'Запущена и отправляется в фоне', 'success');
      setMessage(''); setButtonType(''); setButtonLabel(''); setButtonUrl(''); setPromoCode(''); setImageUrl(''); setSubject('');
      loadStats(); loadHistory();
    } catch (e: any) { let m = 'Не удалось запустить рассылку'; try { const p = JSON.parse(e?.message || ''); m = p?.detail?.message || m; } catch {} onToast('Ошибка', m, 'error'); } finally { setIsSending(false); }
  };

  const targets = [{ v: 'all', l: 'Все' }, { v: 'active', l: 'Активные' }, { v: 'expired', l: 'Истёкшие' }, { v: 'no_subscription', l: 'Без подписки' }];
  const historyBadge = (s: string) => s === 'Completed' ? { cls: 'solid', label: 'Отправлено' } : s === 'Sending' ? { cls: 'mute', label: 'Отправляется' } : s === 'Cancelled' ? { cls: 'danger', label: 'Отменено' } : { cls: 'line', label: s };

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Рассылка" sub="Массовая отправка сообщений" />
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Stat title="Отправлено сообщений" value={stats ? fmtInt(stats.totalSent) : '—'} icon={Send} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 card" style={{ padding: 24 }}>
          <h3 className="h-sec mb-4 flex items-center gap-2"><Plus size={18} className="faint" /> Новая рассылка</h3>
          <div className="flex flex-col gap-4">
            <div>
              <label className="field-label">Каналы</label>
              <div className="flex gap-2">
                <button type="button" className={`nav-item ${chTelegram ? 'on' : ''}`} style={{ flex: 1, justifyContent: 'center' }} onClick={() => setChTelegram(!chTelegram)}><Send size={15} /> Telegram</button>
                <button type="button" className={`nav-item ${chEmail ? 'on' : ''}`} style={{ flex: 1, justifyContent: 'center' }} onClick={() => setChEmail(!chEmail)}><Mail size={15} /> Почта</button>
              </div>
            </div>
            {chEmail && <div><label className="field-label">Тема письма</label><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Например: Новости BlinVPN" /></div>}
            <div><label className="field-label">Текст сообщения</label><textarea className="textarea" style={{ minHeight: 128 }} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Текст рассылки… Поддерживается Markdown" /></div>
            <div><label className="field-label">Тип кнопки</label>
              <select className="select" value={buttonType} onChange={(e) => { setButtonType(e.target.value); setButtonLabel(''); setButtonUrl(''); setPromoCode(''); }}>
                <option value="">Без кнопки</option><option value="external_link">Сторонняя ссылка</option><option value="open_miniapp">Открыть мини-приложение</option><option value="activate_promo">Активировать промокод</option>
              </select>
            </div>
            {(buttonType === 'external_link' || buttonType === 'open_miniapp') && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div><label className="field-label">Текст на кнопке</label><input className="input" value={buttonLabel} onChange={(e) => setButtonLabel(e.target.value)} placeholder={buttonType === 'open_miniapp' ? 'Открыть' : 'Перейти'} /></div>
                <div><label className="field-label">Ссылка</label><input className="input" value={buttonUrl} onChange={(e) => setButtonUrl(e.target.value)} placeholder="https://example.com" /></div>
              </div>
            )}
            {buttonType === 'activate_promo' && <div><label className="field-label">Промокод</label><input className="input mono" value={promoCode} onChange={(e) => setPromoCode(e.target.value)} placeholder="PROMOCODE" /></div>}
            <div>
              <label className="field-label">Картинка (URL, опционально)</label>
              <input className="input" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…/image.jpg" />
              <div className="faint mt-1" style={{ fontSize: 12 }}>Форматирование: &lt;b&gt;, &lt;i&gt;, &lt;code&gt;, **жирный**, *курсив*, `моно`; premium-emoji: ![ID]</div>
            </div>
            <div>
              <label className="field-label">Получатели</label>
              <div className="flex flex-wrap gap-2">
                {targets.map((t) => <button key={t.v} className={`chip ${targetUsers === t.v ? 'on' : ''}`} onClick={() => setTargetUsers(t.v)}>{t.l}</button>)}
              </div>
            </div>
            <button className="btn solid block" onClick={handleSend} disabled={isSending} style={{ padding: 12 }}>{isSending ? <><Spinner size={16} /> Запуск…</> : <><Send size={16} /> Отправить</>}</button>
          </div>
        </div>

        <div className="tbl-wrap" style={{ display: 'flex', flexDirection: 'column', maxHeight: 620 }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}><h3 className="h-sec">История</h3></div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {history.length === 0 ? <div className="sub" style={{ padding: 16, textAlign: 'center' }}>Нет рассылок</div>
              : history.map((item) => {
                  const b = historyBadge(item.status);
                  return (
                    <div key={item.id} style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
                      <div className="flex justify-between items-start gap-2 mb-2">
                        <span className="line-clamp-1" style={{ fontWeight: 500 }}>{item.title || 'Без названия'}</span>
                        <span className="faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{item.date}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className={`badge ${b.cls}`}>{b.label}</span>
                        <span className="sub flex items-center gap-1"><Users size={12} /> {item.sent_count || 0}</span>
                      </div>
                      <div className="flex gap-2 mt-3">
                        <button className="btn sm" onClick={() => setSelected(item)}>Открыть</button>
                        <button className="btn sm danger" onClick={async () => {
                          if (!confirm('Удалить рассылку и попытаться удалить сообщения у пользователей?')) return;
                          try { await apiFetch(`/panel/mailing/${item.id}`, { method: 'DELETE' }); onToast('Готово', 'Рассылка удалена', 'success'); loadHistory(); }
                          catch { onToast('Ошибка', 'Не удалось удалить', 'error'); }
                        }}>Удалить</button>
                      </div>
                    </div>
                  );
                })}
          </div>
        </div>
      </div>

      {selected && (
        <Modal onClose={() => setSelected(null)} title={selected.title || 'Текст рассылки'} width={640} z={70}>
          <div className="inset mono" style={{ padding: 16, whiteSpace: 'pre-wrap', maxHeight: '60vh', overflow: 'auto', fontSize: 13 }}>{selected.message_text || 'Пустое сообщение'}</div>
        </Modal>
      )}
    </div>
  );
};

// ==========================================================
// 12. PROMOCODES
// ==========================================================

const PromocodesStats: React.FC<{ promos: Promo[] }> = ({ promos }) => {
  const [stats, setStats] = useState<{ total: number; totalUses: number; activeCount: number } | null>(null);
  useEffect(() => { (async () => { try { const d = await apiFetch('/panel/promocodes/stats'); if (d) setStats(d); } catch (e) { console.error(e); } })(); }, []);
  const avgDiscount = promos.length ? Math.round(promos.reduce((s, p) => s + Number(p.value || 0), 0) / promos.length) : 0;
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Stat title="Активных кодов" value={stats ? stats.activeCount : promos.length} icon={Gift} />
      <Stat title="Активаций" value={stats ? fmtInt(stats.totalUses) : '0'} icon={Users} />
      <Stat title="Средняя скидка" value={`${avgDiscount}%`} icon={Percent} />
    </div>
  );
};

// Дата для <input type="date"> (ожидает YYYY-MM-DD)
const toDateInput = (iso: string): string => (iso ? String(iso).slice(0, 10) : '');
// В ISO-конец дня UTC, чтобы промокод действовал весь указанный день
const dateInputToIso = (d: string): string | null => (d ? `${d}T23:59:59+00:00` : null);
const fmtDateRu = (iso: string): string => {
  if (!iso) return 'Без срока';
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return 'Без срока';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(dt.getDate())}.${p(dt.getMonth() + 1)}.${dt.getFullYear()}`;
};

const PromocodesPage: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [promos, setPromos] = useState<Promo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Promo | null>(null);
  const [form, setForm] = useState<{ code: string; name: string; value: string; limit: string; expires: string }>({ code: '', name: '', value: '', limit: '', expires: '' });

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiFetch('/panel/promocodes');
      setPromos(Array.isArray(data) ? data.map((p: any) => ({ id: p.id, code: p.code, name: String(p.name || ''), value: String(p.value ?? ''), uses: Number(p.uses_count || 0), limit: Number(p.uses_limit || 0), expires: String(p.expires_at || '') })) : []);
    } catch { onToast('Ошибка', 'Не удалось загрузить промокоды', 'error'); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    const value = Number(form.value);
    if (!form.code || !form.value || isNaN(value) || value <= 0 || value > 100) { onToast('Ошибка', 'Укажите код и скидку 1–100%', 'error'); return; }
    try {
      await apiFetch('/panel/promocodes', { method: 'POST', body: JSON.stringify({ code: form.code.toUpperCase(), name: form.name || null, value, uses_limit: form.limit ? Number(form.limit) : null, expires_at: dateInputToIso(form.expires), is_active: 1 }) });
      onToast('Готово', 'Промокод создан', 'success');
      setForm({ code: '', name: '', value: '', limit: '', expires: '' }); load();
    } catch (e) { onToast('Ошибка', e instanceof Error ? e.message : 'Не удалось создать', 'error'); }
  };
  const remove = async (id: number) => { if (!confirm('Удалить промокод?')) return; try { await apiFetch(`/panel/promocodes/${id}`, { method: 'DELETE' }); onToast('Готово', 'Промокод удалён', 'success'); load(); } catch { onToast('Ошибка', 'Не удалось удалить', 'error'); } };
  const save = async () => {
    if (!editing) return;
    const value = Number(editing.value);
    if (!editing.code || isNaN(value) || value <= 0 || value > 100) { onToast('Ошибка', 'Укажите код и скидку 1–100%', 'error'); return; }
    try {
      await apiFetch(`/panel/promocodes/${editing.id}`, { method: 'PUT', body: JSON.stringify({ code: editing.code, name: editing.name || null, value, uses_limit: editing.limit || null, expires_at: editing.expires ? (editing.expires.length <= 10 ? dateInputToIso(editing.expires) : editing.expires) : null }) });
      onToast('Готово', 'Промокод обновлён', 'success'); setEditing(null); load();
    } catch (e) { onToast('Ошибка', e instanceof Error ? e.message : 'Не удалось обновить', 'error'); }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Промокоды" sub="Скидочные коды. Активированный промокод действует 90 дней и только один раз." />
      <PromocodesStats promos={promos} />

      <div className="card" style={{ padding: 24 }}>
        <h3 className="h-sec mb-4">Новый промокод</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div><label className="field-label">Код</label><input className="input mono" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="НАПРИМЕР SALE20" /></div>
          <div><label className="field-label">Название</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Осенняя распродажа" /></div>
          <div><label className="field-label">Скидка, %</label><input className="input" type="number" min={1} max={100} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder="20" /></div>
          <div><label className="field-label">Активен до</label><input className="input" type="date" value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })} /></div>
          <div><label className="field-label">Лимит активаций <span className="faint">(необязательно)</span></label><input className="input" type="number" value={form.limit} onChange={(e) => setForm({ ...form, limit: e.target.value })} placeholder="∞" /></div>
        </div>
        <button className="btn solid mt-4" onClick={create}>Создать</button>
      </div>

      <div className="tbl-wrap">
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}><h3 className="h-sec">Список промокодов</h3></div>
        {loading ? <div className="sub" style={{ padding: 32, textAlign: 'center' }}>Загрузка…</div>
          : promos.length === 0 ? <div className="sub" style={{ padding: 32, textAlign: 'center' }}>Промокодов пока нет</div>
          : <div style={{ overflowX: 'auto' }}><table className="tbl">
              <thead><tr><th>Код</th><th>Название</th><th>Скидка</th><th>Активаций</th><th>Лимит</th><th>Активен до</th><th style={{ textAlign: 'right' }}>Действия</th></tr></thead>
              <tbody>{promos.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.code}</td><td className="muted">{p.name || '—'}</td><td style={{ fontWeight: 600 }}>{p.value}%</td>
                  <td className="muted">{p.uses}</td><td className="muted">{p.limit || '∞'}</td><td className="muted">{fmtDateRu(p.expires)}</td>
                  <td style={{ textAlign: 'right' }}><span className="inline-flex gap-2"><button className="icon-btn" onClick={() => setEditing({ ...p })}><Edit2 size={14} /></button><button className="icon-btn danger" onClick={() => remove(p.id)}><Trash2 size={14} /></button></span></td>
                </tr>
              ))}</tbody>
            </table></div>}
      </div>

      {editing && (
        <Modal onClose={() => setEditing(null)} title="Редактировать промокод" width={440}
          footer={<><button className="btn block" onClick={() => setEditing(null)}>Отмена</button><button className="btn solid block" onClick={save}>Сохранить</button></>}>
          <div className="flex flex-col gap-3">
            <div><label className="field-label">Код</label><input className="input mono" value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })} placeholder="Код" /></div>
            <div><label className="field-label">Название</label><input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Название" /></div>
            <div><label className="field-label">Скидка, %</label><input className="input" type="number" min={1} max={100} value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} placeholder="20" /></div>
            <div><label className="field-label">Активен до</label><input className="input" type="date" value={toDateInput(editing.expires)} onChange={(e) => setEditing({ ...editing, expires: e.target.value })} /></div>
            <div><label className="field-label">Лимит активаций</label><input className="input" type="number" value={editing.limit || ''} onChange={(e) => setEditing({ ...editing, limit: Number(e.target.value || 0) })} placeholder="∞" /></div>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ==========================================================
// 13. PROMOTIONS
// ==========================================================

type PromotionType = 'global_discount';
type PromotionItem = {
  id: number; name: string; type: PromotionType; value: number; min_amount: number | null;
  max_amount: number | null; uses_limit: number | null; uses_count: number; expires_at: string | null; is_active: boolean;
};

const PromotionsPage: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const emptyForm = { name: '', value: '', uses_limit: '', expires_at: '', is_active: true };
  const [items, setItems] = useState<PromotionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<PromotionItem | null>(null);

  const load = async () => { setLoading(true); try { const d = await apiFetch('/panel/promotions'); setItems(Array.isArray(d) ? d : []); } catch { onToast('Ошибка', 'Не удалось загрузить акции', 'error'); setItems([]); } finally { setLoading(false); } };
  useEffect(() => { load(); }, []);

  const toPayload = (src: typeof form | PromotionItem) => {
    const isEdit = 'id' in src;
    const valueRaw = isEdit ? String((src as PromotionItem).value) : (src as typeof form).value;
    const limitRaw = isEdit ? ((src as PromotionItem).uses_limit != null ? String((src as PromotionItem).uses_limit) : '') : (src as typeof form).uses_limit;
    const expiresRaw = isEdit ? ((src as PromotionItem).expires_at || '') : ((src as typeof form).expires_at || '');
    let expires_at: string | null = null;
    if (expiresRaw) { const d = new Date(expiresRaw); expires_at = Number.isNaN(d.getTime()) ? String(expiresRaw) : d.toISOString(); }
    return {
      name: src.name.trim(), type: 'global_discount' as PromotionType, value: valueRaw,
      uses_limit: limitRaw !== '' ? Number(limitRaw) : null,
      expires_at, is_active: isEdit ? (src as PromotionItem).is_active : (src as typeof form).is_active,
    };
  };
  const parseApiError = (e: any, fallback: string) => { try { const p = JSON.parse(e?.message || ''); if (p?.error) return String(p.error); } catch {} return fallback; };

  const create = async () => {
    if (!form.name.trim() || !form.value || !form.expires_at) { onToast('Ошибка', 'Заполните название, скидку и дату', 'error'); return; }
    try { await apiFetch('/panel/promotions', { method: 'POST', body: JSON.stringify(toPayload(form)) }); onToast('Готово', 'Скидка создана', 'success'); setForm(emptyForm); load(); }
    catch (e: any) { onToast('Ошибка', parseApiError(e, 'Не удалось создать'), 'error'); }
  };
  const save = async () => {
    if (!editing || !editing.name.trim() || !editing.expires_at) { onToast('Ошибка', 'Заполните название и дату', 'error'); return; }
    try { await apiFetch(`/panel/promotions/${editing.id}`, { method: 'PUT', body: JSON.stringify(toPayload(editing)) }); onToast('Готово', 'Скидка обновлена', 'success'); setEditing(null); load(); }
    catch (e: any) { onToast('Ошибка', parseApiError(e, 'Не удалось обновить'), 'error'); }
  };
  const remove = async (id: number) => { if (!confirm('Удалить скидку?')) return; try { await apiFetch(`/panel/promotions/${id}`, { method: 'DELETE' }); onToast('Готово', 'Скидка удалена', 'success'); load(); } catch { onToast('Ошибка', 'Не удалось удалить', 'error'); } };
  const toggle = async (item: PromotionItem) => { try { await apiFetch(`/panel/promotions/${item.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !item.is_active }) }); load(); } catch { onToast('Ошибка', 'Не удалось изменить статус', 'error'); } };

  const fmtExpires = (s: string | null) => { if (!s) return 'Без срока'; try { return new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return s; } };
  const toLocal = (s: string | null) => { if (!s) return ''; try { const d = new Date(s); if (Number.isNaN(d.getTime())) return ''; const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; } catch { return ''; } };

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Акции" sub="Глобальная скидка — действует на все тарифы для всех пользователей без промокода." />

      <div className="card" style={{ padding: 24 }}>
        <h3 className="h-sec mb-4">Новая скидка</h3>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Название (напр. «Осенняя −20%»)" />
            <input className="input" type="number" step="any" min={1} max={100} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder="Скидка % (напр. 15)" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input className="input" type="number" value={form.uses_limit} onChange={(e) => setForm({ ...form, uses_limit: e.target.value })} placeholder="Лимит использований (необяз.)" />
            <input className="input" type="datetime-local" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} />
          </div>
          <button className="btn solid" style={{ alignSelf: 'flex-start' }} onClick={create}>Создать</button>
        </div>
      </div>

      <div className="tbl-wrap">
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}><h3 className="h-sec">Список скидок</h3></div>
        {loading ? <div className="sub" style={{ padding: 32, textAlign: 'center' }}>Загрузка…</div>
          : items.length === 0 ? <div className="sub" style={{ padding: 32, textAlign: 'center' }}>Скидок пока нет</div>
          : <div style={{ overflowX: 'auto' }}><table className="tbl" style={{ minWidth: 760 }}>
              <thead><tr><th>Название</th><th>Скидка</th><th>Исп.</th><th>До</th><th>Статус</th><th style={{ textAlign: 'right' }}>Действия</th></tr></thead>
              <tbody>{items.map((p) => (
                <tr key={p.id} style={!p.is_active ? { opacity: 0.5 } : undefined}>
                  <td style={{ fontWeight: 500 }}>{p.name}</td>
                  <td style={{ fontWeight: 600 }}>{`−${p.value}%`}</td>
                  <td className="muted">{p.uses_count}{p.uses_limit != null ? ` / ${p.uses_limit}` : ''}</td>
                  <td className="muted" style={{ fontSize: 13 }}>{fmtExpires(p.expires_at)}</td>
                  <td><button className={`badge ${p.is_active ? 'solid' : 'line'}`} onClick={() => toggle(p)}>{p.is_active ? 'Активна' : 'Выкл'}</button></td>
                  <td style={{ textAlign: 'right' }}><span className="inline-flex gap-2"><button className="icon-btn" onClick={() => setEditing({ ...p })}><Edit2 size={14} /></button><button className="icon-btn danger" onClick={() => remove(p.id)}><Trash2 size={14} /></button></span></td>
                </tr>
              ))}</tbody>
            </table></div>}
      </div>

      {editing && (
        <Modal onClose={() => setEditing(null)} title="Редактировать скидку" width={520}
          footer={<><button className="btn block" onClick={() => setEditing(null)}>Отмена</button><button className="btn solid block" onClick={save}>Сохранить</button></>}>
          <div className="flex flex-col gap-3">
            <div><label className="field-label">Название</label><input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Название" /></div>
            <div><label className="field-label">Скидка, %</label><input className="input" type="number" step="any" min={1} max={100} value={editing.value} onChange={(e) => setEditing({ ...editing, value: Number(e.target.value) })} /></div>
            <div><label className="field-label">Лимит использований</label><input className="input" type="number" value={editing.uses_limit ?? ''} onChange={(e) => setEditing({ ...editing, uses_limit: e.target.value === '' ? null : Number(e.target.value) })} placeholder="∞" /></div>
            <div><label className="field-label">Активна до</label><input className="input" type="datetime-local" value={toLocal(editing.expires_at)} onChange={(e) => setEditing({ ...editing, expires_at: e.target.value || null })} /></div>
            <label className="flex items-center gap-2 muted" style={{ fontSize: 13, cursor: 'pointer' }}><input type="checkbox" checked={!!editing.is_active} onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })} /> Активна</label>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ==========================================================
// 14. TRACKING LINKS
// ==========================================================

const TrackingLinksPage: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [links, setLinks] = useState<TrackingLink[]>([]);
  const [stats, setStats] = useState<{ total_links: number; total_clicks: number; total_unique_users: number; total_revenue: number; paid_users: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<(TrackingLink & { users?: TrackingLinkUser[] }) | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editing, setEditing] = useState<TrackingLink | null>(null);
  const [form, setForm] = useState({ name: '', code: '', promocode: '', welcome_message: '' });

  const fmtPct = (n: number) => `${n.toFixed(1)}%`;
  const fmtDate = (s: string) => { if (!s) return '—'; try { return new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return s; } };
  const copy = async (text: string, label = 'Ссылка') => { try { await navigator.clipboard.writeText(text); onToast('Скопировано', `${label} в буфере`, 'success'); } catch { onToast('Ошибка', 'Не удалось скопировать', 'error'); } };

  const load = async () => {
    setLoading(true);
    try {
      const [ld, sd] = await Promise.all([apiFetch('/panel/tracking-links'), apiFetch('/panel/tracking-links/stats')]);
      if (Array.isArray(ld)) setLinks(ld.map((l: any) => ({
        id: l.id, code: l.code, name: l.name || '', promocode: l.promocode || null, welcome_message: l.welcome_message || null,
        url: l.url, clicks: Number(l.clicks || 0), is_active: Boolean(l.is_active), created_at: l.created_at || '',
        unique_users: Number(l.unique_users || 0), new_users: Number(l.new_users || 0), total_revenue: Number(l.total_revenue || 0),
        paid_users: Number(l.paid_users || 0), active_subscriptions: Number(l.active_subscriptions || 0), total_keys: Number(l.total_keys || 0), conversion_rate: Number(l.conversion_rate || 0),
      })));
      if (sd) setStats(sd);
    } catch { onToast('Ошибка', 'Не удалось загрузить ссылки', 'error'); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const openDetail = async (link: TrackingLink) => { setDetail(link); setDetailLoading(true); try { const d = await apiFetch(`/panel/tracking-links/${link.id}`); setDetail(d); } catch { onToast('Ошибка', 'Не удалось загрузить детали', 'error'); } finally { setDetailLoading(false); } };

  const create = async () => {
    if (!form.name.trim()) { onToast('Ошибка', 'Укажите название кампании', 'error'); return; }
    try {
      const body: Record<string, string> = { name: form.name.trim() };
      if (form.code.trim()) body.code = form.code.trim();
      if (form.promocode.trim()) body.promocode = form.promocode.trim().toUpperCase();
      if (form.welcome_message.trim()) body.welcome_message = form.welcome_message.trim();
      const res = await apiFetch('/panel/tracking-links', { method: 'POST', body: JSON.stringify(body) });
      onToast('Готово', `Ссылка создана${res.url ? `: ${res.url}` : ''}`, 'success');
      setForm({ name: '', code: '', promocode: '', welcome_message: '' }); load();
    } catch (e: any) { onToast('Ошибка', e?.message || 'Не удалось создать', 'error'); }
  };
  const remove = async (id: number) => { if (!confirm('Удалить ссылку? Статистика по ней будет потеряна.')) return; try { await apiFetch(`/panel/tracking-links/${id}`, { method: 'DELETE' }); onToast('Готово', 'Ссылка удалена', 'success'); if (detail?.id === id) setDetail(null); load(); } catch { onToast('Ошибка', 'Не удалось удалить', 'error'); } };
  const saveEdit = async () => {
    if (!editing) return;
    try { await apiFetch(`/panel/tracking-links/${editing.id}`, { method: 'PUT', body: JSON.stringify({ name: editing.name, code: editing.code, promocode: editing.promocode || '', welcome_message: editing.welcome_message || '', is_active: editing.is_active }) }); onToast('Готово', 'Ссылка обновлена', 'success'); setEditing(null); load(); }
    catch (e: any) { onToast('Ошибка', e?.message || 'Не удалось обновить', 'error'); }
  };
  const toggle = async (link: TrackingLink) => { try { await apiFetch(`/panel/tracking-links/${link.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !link.is_active }) }); load(); } catch { onToast('Ошибка', 'Не удалось изменить статус', 'error'); } };

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Специальные ссылки" sub="Переходы, регистрации и оплаты рекламных кампаний" />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat title="Активных ссылок" value={stats?.total_links ?? links.length} icon={Link} />
        <Stat title="Всего переходов" value={fmtInt(stats?.total_clicks ?? 0)} icon={MousePointer} />
        <Stat title="Уникальных" value={fmtInt(stats?.total_unique_users ?? 0)} icon={Users} />
        <Stat title="Доход с кампаний" value={fmtMoney(stats?.total_revenue ?? 0)} icon={DollarSign} sub={`${stats?.paid_users ?? 0} оплатили`} />
      </div>

      <div className="card" style={{ padding: 24 }}>
        <h3 className="h-sec">Новая ссылка</h3>
        <p className="sub mt-1 mb-4">Формат: <span className="mono">t.me/{BOT_USERNAME}?start=trk_код</span></p>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Название (YouTube, VK Ads…)" />
          <input className="input mono" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') })} placeholder="Код (ad, yt1…)" />
          <input className="input mono" value={form.promocode} onChange={(e) => setForm({ ...form, promocode: e.target.value.toUpperCase() })} placeholder="Промокод (необяз.)" />
          <button className="btn solid" onClick={create}>Создать ссылку</button>
        </div>
        <textarea className="textarea mono mt-3" style={{ minHeight: 72, fontSize: 13 }} value={form.welcome_message} onChange={(e) => setForm({ ...form, welcome_message: e.target.value })}
          placeholder={"Сообщение при первом переходе (необяз.) — HTML/Markdown Telegram\n<b>Привет!</b> Держи скидку 🎁"} />
        <p className="faint mt-1" style={{ fontSize: 12 }}>Отправляется только при первом переходе. Поддерживается HTML Telegram.</p>
      </div>

      <div className="tbl-wrap">
        <div className="flex items-center justify-between" style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <h3 className="h-sec">Кампании</h3>
          <button className="icon-btn" onClick={load} title="Обновить"><RefreshCw size={15} /></button>
        </div>
        {loading ? <div className="sub" style={{ padding: 32, textAlign: 'center' }}>Загрузка…</div>
          : links.length === 0 ? <div style={{ padding: 48, textAlign: 'center' }}><Link size={36} className="faint" style={{ margin: '0 auto 12px' }} /><p className="muted">Ссылок пока нет</p><p className="sub mt-1">Создайте первую для рекламной кампании</p></div>
          : <div style={{ overflowX: 'auto' }}><table className="tbl" style={{ minWidth: 900 }}>
              <thead><tr><th>Кампания</th><th>Ссылка</th><th style={{ textAlign: 'center' }}>Переходы</th><th style={{ textAlign: 'center' }}>Уник.</th><th style={{ textAlign: 'center' }}>Новые</th><th style={{ textAlign: 'center' }}>Оплатили</th><th style={{ textAlign: 'right' }}>Доход</th><th style={{ textAlign: 'center' }}>Конв.</th><th style={{ textAlign: 'right' }}>Действия</th></tr></thead>
              <tbody>{links.map((l) => (
                <tr key={l.id} style={!l.is_active ? { opacity: 0.5 } : undefined}>
                  <td><div style={{ fontWeight: 500 }}>{l.name || l.code}</div><div className="faint mono" style={{ fontSize: 12 }}>trk_{l.code}{l.promocode ? ` · ${l.promocode}` : ''}</div></td>
                  <td><button className="btn sm" onClick={() => copy(l.url)}><Copy size={13} /> копировать</button></td>
                  <td className="muted" style={{ textAlign: 'center' }}>{l.clicks}</td>
                  <td className="muted" style={{ textAlign: 'center' }}>{l.unique_users}</td>
                  <td style={{ textAlign: 'center' }}>{l.new_users}</td>
                  <td className="muted" style={{ textAlign: 'center' }}>{l.paid_users}</td>
                  <td style={{ textAlign: 'right', fontWeight: 500 }}>{fmtMoney(l.total_revenue)}</td>
                  <td style={{ textAlign: 'center' }}><span className={`badge ${l.conversion_rate >= 10 ? 'solid' : l.conversion_rate >= 3 ? 'mute' : 'line'}`}>{fmtPct(l.conversion_rate)}</span></td>
                  <td style={{ textAlign: 'right' }}><span className="inline-flex gap-1">
                    <button className="icon-btn" onClick={() => openDetail(l)} title="Детали"><BarChart2 size={14} /></button>
                    <button className="icon-btn" onClick={() => toggle(l)} title={l.is_active ? 'Выключить' : 'Включить'}>{l.is_active ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}</button>
                    <button className="icon-btn" onClick={() => setEditing({ ...l })} title="Редактировать"><Edit2 size={14} /></button>
                    <button className="icon-btn danger" onClick={() => remove(l.id)} title="Удалить"><Trash2 size={14} /></button>
                  </span></td>
                </tr>
              ))}</tbody>
            </table></div>}
      </div>

      {editing && (
        <Modal onClose={() => setEditing(null)} title="Редактировать ссылку" width={440}
          footer={<><button className="btn block" onClick={() => setEditing(null)}>Отмена</button><button className="btn solid block" onClick={saveEdit}>Сохранить</button></>}>
          <div className="flex flex-col gap-3">
            <input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Название" />
            <input className="input mono" value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') })} placeholder="Код" />
            <input className="input mono" value={editing.promocode || ''} onChange={(e) => setEditing({ ...editing, promocode: e.target.value.toUpperCase() })} placeholder="Промокод" />
            <textarea className="textarea mono" style={{ minHeight: 80, fontSize: 13 }} value={editing.welcome_message || ''} onChange={(e) => setEditing({ ...editing, welcome_message: e.target.value })} placeholder={"Сообщение при первом переходе (HTML/Markdown)"} />
            <label className="flex items-center gap-2 muted" style={{ fontSize: 13, cursor: 'pointer' }}><input type="checkbox" checked={editing.is_active} onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })} /> Ссылка активна</label>
          </div>
        </Modal>
      )}

      {detail && (
        <div className="modal-backdrop" style={{ zIndex: 60 }} onClick={() => setDetail(null)}>
          <div className="modal" style={{ maxWidth: 860 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <div className="modal-title">{detail.name || detail.code}</div>
                <button className="btn sm mt-1" onClick={() => copy(detail.url)}><Copy size={13} /> {detail.url}</button>
              </div>
              <button className="icon-btn" onClick={() => setDetail(null)}><X size={18} /></button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3" style={{ padding: 20, borderBottom: '1px solid var(--border)' }}>
              <div className="inset" style={{ padding: 12 }}><div className="sub">Переходы</div><div className="stat-value" style={{ fontSize: 20 }}>{detail.clicks}</div></div>
              <div className="inset" style={{ padding: 12 }}><div className="sub">Уникальные</div><div className="stat-value" style={{ fontSize: 20 }}>{detail.unique_users}</div></div>
              <div className="inset" style={{ padding: 12 }}><div className="sub">Доход</div><div className="stat-value" style={{ fontSize: 20 }}>{fmtMoney(detail.total_revenue)}</div></div>
              <div className="inset" style={{ padding: 12 }}><div className="sub">Конверсия</div><div className="stat-value" style={{ fontSize: 20 }}>{fmtPct(detail.conversion_rate)}</div></div>
            </div>
            <div className="modal-body">
              <div className="eyebrow mb-3">Пользователи по ссылке</div>
              {detailLoading ? <div className="sub" style={{ textAlign: 'center', padding: 32 }}>Загрузка…</div>
                : !detail.users?.length ? <div className="sub" style={{ textAlign: 'center', padding: 32 }}>Пока никто не перешёл</div>
                : <table className="tbl">
                    <thead><tr><th>Пользователь</th><th>Переход</th><th style={{ textAlign: 'center' }}>Новый</th><th style={{ textAlign: 'center' }}>Подписки</th><th style={{ textAlign: 'right' }}>Потратил</th></tr></thead>
                    <tbody>{detail.users.map((u) => (
                      <tr key={u.user_id}>
                        <td><div>{u.full_name || u.username || `#${u.telegram_id}`}</div><div className="faint mono" style={{ fontSize: 12 }}>{u.telegram_id}{u.username ? ` · @${u.username}` : ''}</div></td>
                        <td className="muted">{fmtDate(u.visited_at)}</td>
                        <td style={{ textAlign: 'center' }}>{u.is_new_user ? 'да' : <span className="faint">—</span>}</td>
                        <td style={{ textAlign: 'center' }}>{u.active_keys > 0 ? `${u.active_keys} акт.` : u.has_paid ? 'была' : u.trial_used ? 'триал' : <span className="faint">—</span>}</td>
                        <td style={{ textAlign: 'right', fontWeight: 500 }}>{u.total_spent > 0 ? fmtMoney(u.total_spent) : '—'}</td>
                      </tr>
                    ))}</tbody>
                  </table>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ==========================================================
// 15. SQUADS
// ==========================================================

interface SquadConfig {
  id: number; squad_uuid: string; squad_name: string; squad_type: string;
  max_users: number; current_users: number; inbounds_count?: number; is_active: boolean; priority: number;
}

const SquadsPage: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [squads, setSquads] = useState<SquadConfig[]>([]);
  const [mapping, setMapping] = useState<{ vpn: string[]; trial: string[] }>({ vpn: [], trial: [] });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState<SquadConfig | null>(null);

  const load = async () => {
    try { const d = await apiFetch('/panel/squads'); if (d) { setSquads(d.squads || []); setMapping({ vpn: d.mapping?.vpn || [], trial: d.mapping?.trial || [] }); } }
    catch { onToast('Ошибка', 'Не удалось загрузить сквады', 'error'); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const sync = async () => {
    setSyncing(true);
    try { const r = await apiFetch('/panel/squads/sync', { method: 'POST' }); if (r?.success) { onToast('Готово', `Синхронизировано ${r.count} сквадов`, 'success'); load(); } else onToast('Ошибка', r?.error || 'Ошибка синхронизации', 'error'); }
    catch { onToast('Ошибка', 'Не удалось синхронизировать', 'error'); } finally { setSyncing(false); }
  };
  const saveSquad = async (squad: SquadConfig) => {
    try { const r = await apiFetch(`/panel/squads/${squad.squad_uuid}`, { method: 'PUT', body: JSON.stringify({ squad_name: squad.squad_name, squad_type: squad.squad_type, max_users: squad.max_users, priority: squad.priority, is_active: squad.is_active }) }); if (r?.success) { onToast('Готово', 'Сквад обновлён', 'success'); setEditing(null); load(); } }
    catch { onToast('Ошибка', 'Не удалось сохранить', 'error'); }
  };
  const saveMapping = async () => { try { const r = await apiFetch('/panel/squads/mapping', { method: 'PUT', body: JSON.stringify(mapping) }); if (r?.success) onToast('Готово', 'Привязки сохранены', 'success'); } catch { onToast('Ошибка', 'Не удалось сохранить привязки', 'error'); } };
  const toggleMapping = (type: 'vpn' | 'trial', uuid: string) => setMapping((prev) => { const cur = prev[type] || []; return { ...prev, [type]: cur.includes(uuid) ? cur.filter((u) => u !== uuid) : [...cur, uuid] }; });

  if (loading) return <div className="flex items-center justify-center" style={{ height: 240 }}><Spinner size={28} /></div>;

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Сквады" sub="Распределение нагрузки по серверам">
        <button className="btn solid" onClick={sync} disabled={syncing}>{syncing ? <Spinner size={16} /> : <RefreshCw size={16} />} Синхронизировать</button>
      </PageHead>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {squads.map((sq) => {
          const pct = sq.max_users > 0 ? Math.min(100, (sq.current_users / sq.max_users) * 100) : 0;
          return (
            <div key={sq.squad_uuid} className="card card-hover" style={{ padding: 18, opacity: sq.is_active ? 1 : 0.5 }}>
              <div className="flex justify-between items-start mb-3">
                <div><h3 style={{ fontWeight: 600 }}>{sq.squad_name}</h3><span className="badge line mt-1" style={{ marginTop: 6 }}>{sq.squad_type.toUpperCase()}</span></div>
                <button className="icon-btn" onClick={() => setEditing(sq)}><Edit2 size={15} /></button>
              </div>
              <div className="flex flex-col gap-2" style={{ fontSize: 14 }}>
                <div className="flex justify-between"><span className="muted">Пользователей</span><span style={{ fontWeight: 500 }}>{sq.current_users}{sq.max_users > 0 && ` / ${sq.max_users}`}</span></div>
                {sq.inbounds_count != null && <div className="flex justify-between"><span className="muted">Инбаундов</span><span>{sq.inbounds_count}</span></div>}
                <div className="flex justify-between"><span className="muted">Приоритет</span><span>{sq.priority}</span></div>
                {sq.max_users > 0 && <div className="meter mt-1"><i style={{ width: `${pct}%` }} /></div>}
              </div>
            </div>
          );
        })}
      </div>

      {squads.length === 0 && (
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <Zap size={40} className="faint" style={{ margin: '0 auto 12px' }} />
          <h3 className="h-sec mb-2">Нет сквадов</h3>
          <p className="sub mb-4">Синхронизируйте сквады с Remnawave</p>
          <button className="btn solid" onClick={sync} style={{ margin: '0 auto' }}>Синхронизировать</button>
        </div>
      )}

      {squads.length > 0 && (
        <div className="card" style={{ padding: 24 }}>
          <h3 className="h-sec mb-2">Привязка сквадов к типам подписок</h3>
          <p className="sub mb-6">Система выберет сквад с наименьшей нагрузкой из выбранных для каждого типа.</p>
          <div className="flex flex-col gap-5">
            {(['vpn', 'trial'] as const).map((type) => (
              <div key={type}>
                <h4 className="mb-3" style={{ fontWeight: 500 }}>{type === 'vpn' ? 'Подписка (VPN + обход блокировок)' : 'Пробный период'}</h4>
                <div className="flex flex-wrap gap-2">
                  {squads.filter((s) => s.is_active).map((sq) => (
                    <button key={sq.squad_uuid} className={`chip ${mapping[type]?.includes(sq.squad_uuid) ? 'on' : ''}`} onClick={() => toggleMapping(type, sq.squad_uuid)}>{sq.squad_name}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <button className="btn solid mt-6" onClick={saveMapping}>Сохранить привязки</button>
        </div>
      )}

      {editing && (
        <Modal onClose={() => setEditing(null)} title="Редактирование сквада" width={440}
          footer={<><button className="btn block" onClick={() => setEditing(null)}>Отмена</button><button className="btn solid block" onClick={() => saveSquad(editing)}>Сохранить</button></>}>
          <div className="flex flex-col gap-4">
            <div><label className="field-label">Название</label><input className="input" value={editing.squad_name} onChange={(e) => setEditing({ ...editing, squad_name: e.target.value })} /></div>
            <div><label className="field-label">Тип</label><select className="select" value={editing.squad_type} onChange={(e) => setEditing({ ...editing, squad_type: e.target.value })}><option value="vpn">Подписка (VPN + обход)</option><option value="trial">Trial (пробный)</option></select></div>
            <div><label className="field-label">Макс. пользователей (0 = без лимита)</label><input className="input" type="number" value={editing.max_users} onChange={(e) => setEditing({ ...editing, max_users: parseInt(e.target.value) || 0 })} /></div>
            <div><label className="field-label">Приоритет</label><input className="input" type="number" value={editing.priority} onChange={(e) => setEditing({ ...editing, priority: parseInt(e.target.value) || 0 })} /></div>
            <label className="flex items-center gap-2 muted" style={{ fontSize: 13, cursor: 'pointer' }}><input type="checkbox" checked={editing.is_active} onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })} /> Активен</label>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ==========================================================
// 16. BACKUPS
// ==========================================================

const FORUM_TOPICS: { id: string; label: string; hint: string }[] = [
  { id: 'withdrawals', label: 'Выводы', hint: 'запросы на вывод + кнопка «Одобрить»' },
  { id: 'codes', label: 'Коды', hint: 'коды входа в панель' },
  { id: 'backups', label: 'Бэкапы', hint: 'файлы резервных копий БД' },
  { id: 'purchases', label: 'Покупки', hint: 'уведомления об оплатах' },
  { id: 'errors', label: 'Ошибки', hint: 'серверные ошибки' },
];

const ForumSettingsTab: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [chatId, setChatId] = useState('');
  const [panelUrl, setPanelUrl] = useState('');
  const [topics, setTopics] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const d = await apiFetch('/panel/forum');
      setChatId(d?.forum_chat_id || '');
      setPanelUrl(d?.panel_url || '');
      setTopics(d?.topics || {});
    } catch { onToast('Ошибка', 'Не удалось загрузить настройки форума', 'error'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch('/panel/forum', { method: 'PUT', body: JSON.stringify({ forum_chat_id: chatId.trim(), panel_url: panelUrl.trim(), topics }) });
      onToast('Готово', 'Настройки форума сохранены', 'success');
    } catch { onToast('Ошибка', 'Не удалось сохранить', 'error'); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="card" style={{ padding: 24 }}><Spinner size={24} /></div>;

  return (
    <div className="card" style={{ padding: 24 }}>
      <h3 className="h-sec" style={{ paddingBottom: 16, borderBottom: '1px solid var(--border)', marginBottom: 20 }}>Группа-форум Telegram</h3>
      <div className="flex flex-col gap-5">
        <div className="inset flex items-start gap-3" style={{ padding: 14 }}>
          <Send size={18} className="faint" style={{ marginTop: 2, flex: 'none' }} />
          <div className="sub" style={{ fontSize: 13 }}>Создайте группу с топиками (форум), добавьте бота админом. Укажите ID группы (например <span className="mono">-1001234567890</span>) и ID каждого топика. Если не задать — коды/уведомления придут администратору в ЛС.</div>
        </div>
        <div><label className="field-label">ID группы-форума</label><input className="input mono" value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="-1001234567890" /></div>
        <div><label className="field-label">URL панели (для кликабельных id в уведомлениях)</label><input className="input mono" value={panelUrl} onChange={(e) => setPanelUrl(e.target.value)} placeholder="https://panel.blinvpn.cc" /></div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {FORUM_TOPICS.map((t) => (
            <div key={t.id}>
              <label className="field-label">Топик «{t.label}» <span className="faint" style={{ fontWeight: 400 }}>— {t.hint}</span></label>
              <input className="input mono" type="number" value={topics[t.id] ?? ''} onChange={(e) => setTopics({ ...topics, [t.id]: e.target.value })} placeholder="ID топика" />
            </div>
          ))}
        </div>
        <button className="btn solid" style={{ alignSelf: 'flex-start' }} onClick={save} disabled={saving}>{saving ? <Spinner size={16} /> : <Save size={16} />} Сохранить</button>
      </div>
    </div>
  );
};

type BackupFile = { name: string; size: number; created_at: string };

const BackupSettingsTab: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [enabled, setEnabled] = useState(false);
  const [interval, setInterval] = useState('12');
  const [lastBackup, setLastBackup] = useState<string | null>(null);
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [creating, setCreating] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);

  const loadStatus = async () => {
    try { const d = await apiFetch('/panel/backups/status'); if (d) { setEnabled(d.enabled || false); setInterval(d.interval_hours?.toString() || '12'); setLastBackup(d.last_backup || null); setBackups(Array.isArray(d.backups) ? d.backups : []); } }
    catch (e) { console.error(e); }
  };
  useEffect(() => { loadStatus(); }, []);

  const createNow = async () => { setCreating(true); try { const d = await apiFetch('/panel/backups/create', { method: 'POST' }); onToast('Готово', 'Резервная копия создана', 'success'); if (d && Array.isArray(d.backups)) { setBackups(d.backups); setLastBackup(d.last_backup || d.created_at || null); } else loadStatus(); } catch { onToast('Ошибка', 'Не удалось создать копию', 'error'); } setCreating(false); };
  const saveSettings = async () => { try { await apiFetch('/panel/backups/settings', { method: 'PUT', body: JSON.stringify({ enabled, interval_hours: parseInt(interval) }) }); onToast('Готово', 'Настройки сохранены', 'success'); } catch { onToast('Ошибка', 'Не удалось сохранить', 'error'); } };

  const download = async (name: string) => {
    setDownloading(name);
    try {
      const res = await fetch(`/api/panel/backups/download?name=${encodeURIComponent(name)}`, { headers: { Authorization: `Bearer ${getPanelToken()}` } });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch { onToast('Ошибка', 'Не удалось скачать копию', 'error'); }
    setDownloading(null);
  };

  const fmtSize = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`;

  return (
    <div className="card" style={{ padding: 24 }}>
      <h3 className="h-sec" style={{ paddingBottom: 16, borderBottom: '1px solid var(--border)', marginBottom: 20 }}>Резервное копирование</h3>
      <div className="flex flex-col gap-5">
        <div className="inset flex items-center justify-between gap-3" style={{ padding: 14 }}>
          <div><div style={{ fontWeight: 500 }}>Автоматическое копирование</div><div className="sub mt-0.5">Копии базы создаются на сервере по расписанию</div></div>
          <Toggle on={enabled} onChange={() => setEnabled(!enabled)} />
        </div>
        <div><label className="field-label">Частота, часов</label><input className="input" type="number" value={interval} onChange={(e) => setInterval(e.target.value)} placeholder="12" /></div>
        {lastBackup && <div className="inset" style={{ padding: 12 }}><span className="sub">Последняя копия: </span><span>{new Date(lastBackup).toLocaleString('ru-RU')}</span></div>}
        <div className="flex gap-3">
          <button className="btn solid block" onClick={createNow} disabled={creating}>{creating ? <Spinner size={16} /> : <Cloud size={16} />} Создать сейчас</button>
          <button className="btn block" onClick={saveSettings}><Save size={16} /> Сохранить настройки</button>
        </div>

        <div>
          <div className="field-label" style={{ marginBottom: 8 }}>Копии на сервере ({backups.length})</div>
          {backups.length === 0 ? <div className="sub inset" style={{ padding: 12 }}>Копий пока нет. Нажмите «Создать сейчас».</div>
            : <div className="flex flex-col gap-2">{backups.map((b) => (
                <div key={b.name} className="inset flex items-center justify-between gap-3" style={{ padding: '10px 14px' }}>
                  <div style={{ minWidth: 0 }}><div className="mono" style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.name}</div><div className="sub" style={{ fontSize: 12 }}>{new Date(b.created_at).toLocaleString('ru-RU')} · {fmtSize(b.size)}</div></div>
                  <button className="btn sm" onClick={() => download(b.name)} disabled={downloading === b.name}>{downloading === b.name ? <Spinner size={14} /> : <Download size={14} />} Скачать</button>
                </div>
              ))}</div>}
        </div>
      </div>
    </div>
  );
};

type PlanRow = { id?: number; devices: number; price_rub: number; price_stars: number; is_active: boolean; sort_order: number };

const PricesSettingsTab: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [extra, setExtra] = useState('40');
  const [included, setIncluded] = useState('2');
  const [trialEnabled, setTrialEnabled] = useState(true);
  const [trafficResetPrice, setTrafficResetPrice] = useState('0');
  const [antiabuse, setAntiabuse] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [p, m] = await Promise.all([apiFetch('/panel/plans'), apiFetch('/panel/plans/meta')]);
      setPlans(Array.isArray(p) ? p : []);
      if (m) {
        setExtra(String(m.extra_device_price ?? 40));
        setIncluded(String(m.default_included_devices ?? 2));
        setTrialEnabled(m.trial_enabled !== false);
        setTrafficResetPrice(String(m.traffic_reset_price ?? 0));
        setAntiabuse(m.antiabuse_enabled !== false);
      }
    } catch { onToast('Ошибка', 'Не удалось загрузить тарифы', 'error'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const updatePlan = (idx: number, patch: Partial<PlanRow>) => {
    setPlans((prev) => prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  };

  const addPlan = () => {
    setPlans((prev) => [...prev, { devices: 1, price_rub: 99, price_stars: 99, is_active: true, sort_order: prev.length + 1 }]);
  };

  const removePlan = (idx: number) => {
    setPlans((prev) => prev.filter((_, i) => i !== idx));
  };

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch('/panel/plans', {
        method: 'PUT',
        body: JSON.stringify({
          plans: plans.map((p, i) => ({
            devices: Number(p.devices),
            price_rub: Number(p.price_rub),
            price_stars: Number(p.price_stars),
            is_active: !!p.is_active,
            sort_order: i + 1,
          })),
          extra_device_price: Number(extra),
          default_included_devices: Number(included),
          trial_enabled: trialEnabled,
          traffic_reset_price: Number(trafficResetPrice),
          antiabuse_enabled: antiabuse,
        }),
      });
      onToast('Готово', 'Тарифы сохранены — мини-приложение подхватит сразу', 'success');
      load();
    } catch { onToast('Ошибка', 'Не удалось сохранить тарифы', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div className="card" style={{ padding: 24 }}>
      <h3 className="h-sec" style={{ paddingBottom: 16, borderBottom: '1px solid var(--border)', marginBottom: 20 }}>Тарифы и цены</h3>
      {loading ? <div className="sub">Загрузка…</div> : (
        <div className="flex flex-col gap-5">
          <p className="sub">Цены из этой таблицы сразу отображаются в мини-приложении (оплата, продление, старт).</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="field-label">Цена доп. устройства, ₽/мес</label><input className="input" type="number" value={extra} onChange={(e) => setExtra(e.target.value)} /></div>
            <div><label className="field-label">Устройств в тарифе по умолчанию</label><input className="input" type="number" value={included} onChange={(e) => setIncluded(e.target.value)} /></div>
            <div><label className="field-label">Досрочный сброс трафика, ₽ (0 = выкл.)</label><input className="input" type="number" value={trafficResetPrice} onChange={(e) => setTrafficResetPrice(e.target.value)} /></div>
          </div>
          <div className="inset flex items-center justify-between gap-3" style={{ padding: 14 }}>
            <div><div style={{ fontWeight: 500 }}>Пробный период (3 дня)</div><div className="sub mt-0.5">Выключите — и в мини-приложении/на сайте нельзя будет взять пробный, только оплата.</div></div>
            <Toggle on={trialEnabled} onChange={() => setTrialEnabled(!trialEnabled)} />
          </div>
          <div className="inset flex items-center justify-between gap-3" style={{ padding: 14 }}>
            <div><div style={{ fontWeight: 500 }}>Анти-абуз (HWID/IP)</div><div className="sub mt-0.5">Автобан подписок за превышение устройств (HWID ×3) и IP (лимит+2). Проверка по данным Remnawave.</div></div>
            <Toggle on={antiabuse} onChange={() => setAntiabuse(!antiabuse)} />
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Устройств</th><th>₽</th><th>⭐ (= ₽)</th><th>Активен</th><th></th></tr></thead>
              <tbody>
                {plans.map((p, idx) => (
                  <tr key={idx}>
                    <td><input className="input" type="number" value={p.devices} onChange={(e) => updatePlan(idx, { devices: Number(e.target.value) })} style={{ width: 90 }} /></td>
                    <td><input className="input" type="number" value={p.price_rub} onChange={(e) => updatePlan(idx, { price_rub: Number(e.target.value), price_stars: Math.round(Number(e.target.value)) })} style={{ width: 110 }} /></td>
                    <td><span className="sub" title="Курс фиксированный: 1 звезда = 1 рубль">{Math.round(p.price_rub)} ⭐</span></td>
                    <td><Toggle on={!!p.is_active} onChange={() => updatePlan(idx, { is_active: !p.is_active })} /></td>
                    <td><button className="icon-btn" onClick={() => removePlan(idx)} title="Удалить"><Trash2 size={15} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-3">
            <button className="btn" onClick={addPlan}><Plus size={16} /> Добавить тариф</button>
            <button className="btn solid" onClick={save} disabled={saving}>{saving ? <Spinner size={16} /> : <Save size={16} />} Сохранить</button>
          </div>
        </div>
      )}
    </div>
  );
};

const LegalSettingsTab: React.FC<{
  kind: 'offer' | 'privacy';
  title: string;
  onToast: (t: string, m: string, ty: ToastType) => void;
}> = ({ kind, title, onToast }) => {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const path = kind === 'offer' ? '/panel/content/offer' : '/panel/content/privacy';

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const d = await apiFetch(path);
        setText(d?.text || '');
      } catch { onToast('Ошибка', `Не удалось загрузить: ${title}`, 'error'); }
      finally { setLoading(false); }
    })();
  }, [path]);

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch(path, { method: 'PUT', body: JSON.stringify({ text }) });
      onToast('Готово', `${title} сохранён — мини-приложение обновится сразу`, 'success');
    } catch { onToast('Ошибка', 'Не удалось сохранить', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div className="card" style={{ padding: 24 }}>
      <h3 className="h-sec" style={{ paddingBottom: 16, borderBottom: '1px solid var(--border)', marginBottom: 20 }}>{title}</h3>
      {loading ? <div className="sub">Загрузка…</div> : (
        <div className="flex flex-col gap-4">
          <p className="sub">Текст хранится в БД и отдаётся мини-приложению через API.</p>
          <textarea className="textarea mono" style={{ minHeight: 360, fontSize: 13, lineHeight: 1.5 }} value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn solid" style={{ alignSelf: 'flex-start' }} onClick={save} disabled={saving}>
            {saving ? <Spinner size={16} /> : <Save size={16} />} Сохранить
          </button>
        </div>
      )}
    </div>
  );
};

// ==========================================================
// 17. SETTINGS
// ==========================================================

const SettingsPage: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [activeTab, setActiveTab] = useState<'prices' | 'offer' | 'privacy' | 'squads' | 'backups' | 'forum'>('prices');
  const tabs = [
    { id: 'prices', icon: DollarSign, label: 'Цены' },
    { id: 'offer', icon: FileText, label: 'Оферта' },
    { id: 'privacy', icon: Shield, label: 'Конфиденциальность' },
    { id: 'squads', icon: Zap, label: 'Сквады' },
    { id: 'forum', icon: Send, label: 'Форум' },
    { id: 'backups', icon: Cloud, label: 'Резервные копии' },
  ] as const;

  return (
    <div className="flex flex-col lg:flex-row gap-6">
      <div style={{ width: 220, flex: 'none' }} className="w-full lg:!w-[220px]">
        <div className="card" style={{ position: 'sticky', top: 80, overflow: 'hidden' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}><span className="h-sec">Категории</span></div>
          <div style={{ padding: 8 }} className="flex flex-col gap-1">
            {tabs.map((t) => (
              <button key={t.id} className={`nav-item ${activeTab === t.id ? 'on' : ''}`} onClick={() => setActiveTab(t.id)}><t.icon size={16} className={activeTab === t.id ? '' : 'faint'} /> {t.label}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex-1">
        {activeTab === 'prices' && <PricesSettingsTab onToast={onToast} />}
        {activeTab === 'offer' && <LegalSettingsTab kind="offer" title="Договор оферты" onToast={onToast} />}
        {activeTab === 'privacy' && <LegalSettingsTab kind="privacy" title="Политика конфиденциальности" onToast={onToast} />}
        {activeTab === 'squads' && <SquadsPage onToast={onToast} />}
        {activeTab === 'forum' && <ForumSettingsTab onToast={onToast} />}
        {activeTab === 'backups' && <BackupSettingsTab onToast={onToast} />}
      </div>
    </div>
  );
};
