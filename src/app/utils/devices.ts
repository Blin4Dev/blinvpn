/** Разбивка числа устройств на базовый тариф + доп. слоты. */
export function splitDevices(
  total: number,
  planSizes: number[],
): { plan: number; extra: number } {
  const n = Math.max(1, Math.min(50, Math.floor(total) || 1));
  const sorted = [...planSizes].filter((x) => x > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return { plan: 1, extra: Math.max(0, n - 1) };
  let plan = sorted[0]!;
  for (const p of sorted) {
    if (p <= n) plan = p;
    else break;
  }
  return { plan, extra: Math.max(0, n - plan) };
}

export function estimateDevicePrice(
  total: number,
  priceMap: Record<number, number>,
  extraPrice: number,
  months = 1,
): number {
  const sizes = Object.keys(priceMap).map(Number);
  const { plan, extra } = splitDevices(total, sizes);
  const base = priceMap[plan] ?? 99;
  return Math.round(base * months + extra * extraPrice);
}

export function deviceWord(n: number): string {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return "устройств";
  if (d === 1) return "устройство";
  if (d >= 2 && d <= 4) return "устройства";
  return "устройств";
}
