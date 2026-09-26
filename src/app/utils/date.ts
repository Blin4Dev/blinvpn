const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

/** "2026-09-24T…" → "24 сентября 2026" (по локальному времени пользователя). */
export function formatDateRu(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getDate()} ${MONTHS_GENITIVE[d.getMonth()]} ${d.getFullYear()}`;
}

/** Человеческое «когда»: «только что», «5 минут назад», «сегодня в 14:05», «вчера в 09:30», «3 сентября в 18:00». */
export function formatWhenRu(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (diffMin < 1) return "только что";
  if (diffMin < 60) {
    const n = diffMin, a = n % 10, b = n % 100;
    const w = a === 1 && b !== 11 ? "минуту" : a >= 2 && a <= 4 && (b < 12 || b > 14) ? "минуты" : "минут";
    return `${n} ${w} назад`;
  }
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days === 0) return `сегодня в ${hm}`;
  if (days === 1) return `вчера в ${hm}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${d.getDate()} ${MONTHS_GENITIVE[d.getMonth()]}${sameYear ? "" : ` ${d.getFullYear()}`} в ${hm}`;
}
