

// Стандартный процент реферальной программы (как в БД по умолчанию)
export const DEFAULT_REF_RATE = 25;

export const fmtInt = (v: number | null | undefined) => (v ?? 0).toLocaleString('ru-RU', { maximumFractionDigits: 0 });

export const fmtMoney = (v: number | null | undefined) => `${fmtInt(v)} ₽`;

export const gb = (bytes: number) => (bytes / 1024 ** 3);

export function toSeries(raw: any): { label: string; value: number }[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((d: any) => ({
    label: String(d.label ?? d.date ?? d.day ?? d.name ?? ''),
    value: Number(d.value ?? d.amount ?? d.revenue ?? d.total ?? d.count ?? 0) || 0,
  }));
}

export const fmtDT = (s?: string | null) => {
  if (!s) return '—';
  try { return new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return s; }
};

export const shortHash = (h: string) => (h.length > 22 ? `${h.slice(0, 10)}…${h.slice(-8)}` : h);

export const fmtDelta = (d?: number | null) => (d == null ? null : `${d > 0 ? '+' : ''}${d.toFixed(Math.abs(d) >= 10 ? 0 : 1)}%`);

export const pctStr = (v?: number | null) => (v == null ? '—' : `${v.toFixed(v >= 10 ? 0 : 1)}%`);

export const hoursStr = (h?: number | null) => (h == null ? '—' : h < 1 ? `${Math.round(h * 60)} мин` : h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)} ч` : `${Math.round(h / 24)} дн`);

export const fmtDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export const relTime = (iso: string | null | undefined): string => {
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

// ── Особые действия с подпиской: обмен устройств на дни, перенос ──
export const dayWord = (n: number) => { const a = Math.abs(Math.round(n)); return a % 10 === 1 && a % 100 !== 11 ? 'день' : a % 10 >= 2 && a % 10 <= 4 && (a % 100 < 12 || a % 100 > 14) ? 'дня' : 'дней'; };

export const devWord = (n: number) => { const a = Math.abs(n); return a % 10 === 1 && a % 100 !== 11 ? 'устройство' : a % 10 >= 2 && a % 10 <= 4 && (a % 100 < 12 || a % 100 > 14) ? 'устройства' : 'устройств'; };

export const fmtDays = (d: number) => `${Number.isInteger(d) ? d : d.toFixed(1).replace('.', ',')} ${dayWord(d)}`;

// Дата для <input type="date"> (ожидает YYYY-MM-DD)
export const toDateInput = (iso: string): string => (iso ? String(iso).slice(0, 10) : '');

// В ISO-конец дня UTC, чтобы промокод действовал весь указанный день
export const dateInputToIso = (d: string): string | null => (d ? `${d}T23:59:59+00:00` : null);

export const fmtDateRu = (iso: string): string => {
  if (!iso) return 'Без срока';
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return 'Без срока';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(dt.getDate())}.${p(dt.getMonth() + 1)}.${dt.getFullYear()}`;
};

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
/** «только что», «5 минут назад», «сегодня в 14:05», «вчера в 09:30», «3 сентября в 18:00». */
export const whenRu = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso); if (isNaN(d.getTime())) return '—';
  const now = new Date();
  const min = Math.floor((now.getTime() - d.getTime()) / 60000);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (min < 1) return 'только что';
  if (min < 60) {
    const a = min % 10, b = min % 100;
    return `${min} ${a === 1 && b !== 11 ? 'минуту' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'минуты' : 'минут'} назад`;
  }
  const day0 = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day0(now) - day0(d)) / 86400000);
  if (days === 0) return `сегодня в ${hm}`;
  if (days === 1) return `вчера в ${hm}`;
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`} в ${hm}`;
};
