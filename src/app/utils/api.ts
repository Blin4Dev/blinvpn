/** API-клиент мини-приложения BlinVPN */

export type Plan = { devices: number; price_rub: number; price_stars: number };
export type PlansResponse = {
  plans: Plan[];
  extra_device_price: number;
  default_devices: number;
};

export type Discount = {
  percent: number;
  expires_at?: string | null;
  code?: string | null;
  name?: string | null;
} | null;

export type AppUser = {
  id?: number;
  telegram_id?: number;
  username?: string;
  email?: string | null;
  balance?: number;
  subscription_status?: string;
  subscription_until?: string | null;
  is_banned?: boolean;
  referral_code?: string;
  is_partner?: boolean;
  partner_balance?: number;
  discount?: Discount;
};

/** Активная скидка пользователя (для зачёркнутой цены). Возвращает percent 0, если нет. */
export async function fetchDiscount(): Promise<{ active: boolean; percent: number; expires_at?: string | null }> {
  try {
    return await appFetch("/discount");
  } catch {
    return { active: false, percent: 0 };
  }
}

/** Применить процент скидки к цене (округление до целого, не ниже 1). */
export function applyDiscount(amount: number, percent: number): number {
  if (!percent || percent <= 0) return amount;
  return Math.max(1, Math.round(amount * (1 - percent / 100)));
}

const APP_TOKEN_KEY = "blinvpn_app_token";

export function getAppToken(): string {
  try {
    return localStorage.getItem(APP_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setAppToken(token: string): void {
  try {
    localStorage.setItem(APP_TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
}

export function clearAppToken(): void {
  try {
    localStorage.removeItem(APP_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

function initDataHeader(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    const initData = (
      window as unknown as { Telegram?: { WebApp?: { initData?: string } } }
    ).Telegram?.WebApp?.initData?.trim();
    if (initData) headers["X-Telegram-Init-Data"] = initData;
  } catch {
    /* ignore */
  }
  const token = getAppToken();
  if (token) headers["X-App-Session"] = token;
  return headers;
}

export async function appFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const clean = path.startsWith("/") ? path : `/${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...initDataHeader(),
    ...(options.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`/api/app${clean}`, { ...options, headers });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (body && (body.detail?.message || body.detail || body.error)) ||
      `Ошибка ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return body as T;
}

export async function fetchPlans(): Promise<PlansResponse> {
  const data = await appFetch<PlansResponse>("/plans");
  return {
    plans: Array.isArray(data?.plans) ? data.plans : [],
    extra_device_price: Number(data?.extra_device_price ?? 40),
    default_devices: Number(data?.default_devices ?? 2),
  };
}

export function plansToPriceMap(plans: Plan[]): Record<number, number> {
  const map: Record<number, number> = {};
  for (const p of plans) map[p.devices] = p.price_rub;
  return map;
}

export function plansToStarsMap(plans: Plan[]): Record<number, number> {
  const map: Record<number, number> = {};
  for (const p of plans) map[p.devices] = p.price_stars;
  return map;
}

export function minPlanPrice(plans: Plan[]): number {
  if (!plans.length) return 99;
  return Math.min(...plans.map((p) => p.price_rub));
}

export async function fetchLegal(): Promise<{ offer: string; privacy: string }> {
  return appFetch("/legal");
}

export async function authAndGetUser(): Promise<AppUser | null> {
  try {
    const headers = initDataHeader();
    if (!headers["X-Telegram-Init-Data"]) return null;
    const res = await fetch("/api/app/auth", { method: "POST", headers });
    if (!res.ok) return null;
    const body = (await res.json()) as { user?: AppUser };
    return body.user || null;
  } catch {
    return null;
  }
}

// ── Платежи ────────────────────────────────────────────────

export type PaymentMethod = "sbp" | "card" | "sberpay" | "tg_stars";
export type PaymentPurpose = "subscription" | "extend" | "devices" | "traffic_reset";

export type CreatePaymentRequest = {
  plan_devices: number;
  months?: number;
  method: PaymentMethod;
  extra_devices?: number;
  purpose?: PaymentPurpose;
  subscription_id?: number | null;
  use_referral_balance?: boolean;
};

export type CreatePaymentResponse = {
  payment_id: string;
  amount: number;
  full_price?: number;
  referral_applied?: number;
  currency: string;
  method: string;
  provider: "platega" | "tg_stars" | "balance";
  pay_url?: string | null;
  invoice_link?: string | null;
  transaction_id?: string;
  status: string;
  paid?: boolean;
};

export type PaymentStatusResponse = {
  payment_id: string;
  status: "pending" | "paid" | "failed";
  provider?: string;
  amount?: number;
  currency?: string;
  pay_url?: string | null;
  invoice_link?: string | null;
  subscription?: unknown;
};

export async function createPayment(
  req: CreatePaymentRequest,
): Promise<CreatePaymentResponse> {
  return appFetch<CreatePaymentResponse>("/payment/create", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function fetchPaymentStatus(
  paymentId: string,
): Promise<PaymentStatusResponse> {
  return appFetch<PaymentStatusResponse>(
    `/payment/status?payment_id=${encodeURIComponent(paymentId)}`,
  );
}

export type PaymentQuote = {
  purpose: string;
  price: number;
  stars: number;
  referral_applied: number;
  charge: number;
  provider_min: number;
  is_stars: boolean;
};

/** Предпросмотр цены (итог + сколько спишется с реф. баланса), без создания платежа. */
export async function fetchQuote(req: CreatePaymentRequest): Promise<PaymentQuote | null> {
  try {
    return await appFetch<PaymentQuote>("/payment/quote", {
      method: "POST",
      body: JSON.stringify(req),
    });
  } catch {
    return null;
  }
}

export type SubKey = {
  id?: number;
  status?: string;
  expiry_date?: string | null;
  days_left?: number | null;
  devices_limit?: number;
  type?: string;
  frozen?: boolean;
};

export async function fetchSubscription(): Promise<{ until?: string | null; key?: SubKey | null; frozen?: boolean } | null> {
  try {
    return await appFetch("/subscription");
  } catch {
    return null;
  }
}

export async function freezeSubscription(): Promise<{ ok: boolean; error?: string }> {
  try {
    await appFetch("/subscription/freeze", { method: "POST" });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Ошибка" };
  }
}

export async function unfreezeSubscription(): Promise<{ ok: boolean; error?: string }> {
  try {
    await appFetch("/subscription/unfreeze", { method: "POST" });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Ошибка" };
  }
}

// ── Telegram WebApp ────────────────────────────────────────

type TgWebApp = {
  openInvoice?: (
    url: string,
    callback?: (status: "paid" | "cancelled" | "failed" | "pending") => void,
  ) => void;
  openLink?: (url: string, options?: { try_instant_view?: boolean }) => void;
  openTelegramLink?: (url: string) => void;
};

export function tgWebApp(): TgWebApp | null {
  try {
    return (
      (window as unknown as { Telegram?: { WebApp?: TgWebApp } }).Telegram
        ?.WebApp ?? null
    );
  } catch {
    return null;
  }
}

/** Открыть счёт Telegram Stars; резолвится финальным статусом. */
export function openStarsInvoice(url: string): Promise<string> {
  return new Promise((resolve) => {
    const wa = tgWebApp();
    if (wa?.openInvoice) {
      wa.openInvoice(url, (status) => resolve(status));
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
      resolve("pending");
    }
  });
}

/** Открыть внешнюю платёжную ссылку (Platega). */
export function openPayUrl(url: string): void {
  const wa = tgWebApp();
  if (wa?.openLink) wa.openLink(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Открыть поддержку с уже вписанным логом ошибки:
 * https://t.me/blinteams?text=Здравствуйте. У меня возникла ошибка: <log>
 */
export function openSupportWithError(errorLog: string, supportBase = "https://t.me/blinteams"): void {
  const base = (supportBase || "https://t.me/blinteams").split("?")[0];
  const text = `Здравствуйте. У меня возникла ошибка: ${errorLog}`;
  const url = `${base}?text=${encodeURIComponent(text)}`;
  const wa = tgWebApp();
  if (wa?.openTelegramLink && /^https?:\/\/t\.me\//i.test(url)) wa.openTelegramLink(url);
  else if (wa?.openLink) wa.openLink(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

// ── Аккаунт / безопасность ─────────────────────────────────

export async function fetchMe(): Promise<AppUser | null> {
  try {
    const b = await appFetch<{ user: AppUser }>("/me");
    return b.user;
  } catch {
    return null;
  }
}

export async function requestBindEmailCode(email: string): Promise<EmailRequestResult> {
  return appFetch<EmailRequestResult>("/me/email/request", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function updateEmail(email: string, code: string): Promise<AppUser> {
  const b = await appFetch<{ user: AppUser }>("/me/email", {
    method: "PUT",
    body: JSON.stringify({ email, code }),
  });
  return b.user;
}

export async function unbindEmail(): Promise<AppUser> {
  const b = await appFetch<{ user: AppUser }>("/me/email", { method: "DELETE" });
  return b.user;
}

// ── Авторизация: email-код + сессии ────────────────────────

export type EmailRequestResult = { ok: boolean; throttled: boolean; resend_after: number; dev_code?: string };

export async function requestEmailCode(email: string): Promise<EmailRequestResult> {
  return appFetch<EmailRequestResult>("/auth/email/request", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function verifyEmailCode(email: string, code: string): Promise<AppUser> {
  const b = await appFetch<{ user: AppUser; token: string }>("/auth/email/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  if (b.token) setAppToken(b.token);
  return b.user;
}

export async function logout(): Promise<void> {
  try {
    await appFetch("/auth/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  clearAppToken();
}

/** Проверка текущей авторизации (Telegram initData или сохранённая сессия). */
export async function checkAuth(): Promise<boolean> {
  const inTelegram = (() => {
    try {
      const wa = (window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp;
      return Boolean(wa?.initData && wa.initData.length > 0);
    } catch {
      return false;
    }
  })();
  if (inTelegram) return true;
  if (!getAppToken()) return false;
  const me = await fetchMe();
  if (!me) {
    clearAppToken();
    return false;
  }
  return true;
}

export type TelegramOAuthPayload = {
  id: number | string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date?: number | string;
  hash: string;
};

export async function bindTelegram(payload: TelegramOAuthPayload): Promise<AppUser> {
  const b = await appFetch<{ user: AppUser }>("/me/telegram", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  return b.user;
}

// ── Устройства ──────────────────────────────────────────────

export async function revokeDevice(deviceId: string): Promise<boolean> {
  try {
    await appFetch(`/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
    return true;
  } catch {
    return false;
  }
}

// ── Конфиг / пробный период ─────────────────────────────────

export async function fetchConfig(): Promise<Record<string, unknown>> {
  try {
    return await appFetch("/config");
  } catch {
    return {};
  }
}

/** Запущено ли приложение внутри Telegram (есть подписанный initData). */
export function isTelegram(): boolean {
  try {
    const wa = (window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp;
    return Boolean(wa?.initData && wa.initData.length > 0);
  } catch {
    return false;
  }
}

export type Membership = {
  required: boolean;
  subscribed: boolean;
  channel_url: string;
  optional_url?: string;
};

/** Статус обязательной подписки на канал (только для Telegram-входа). */
export async function fetchMembership(force = false): Promise<Membership> {
  try {
    return await appFetch<Membership>(`/membership${force ? "?force=1" : ""}`);
  } catch {
    // не смогли проверить — не блокируем
    return { required: false, subscribed: true, channel_url: "https://t.me/blinvpn" };
  }
}

export type SetupStatus = {
  show_setup_prompt: boolean;
  has_subscription: boolean;
  ever_connected: boolean | null;
};

/**
 * Нужно ли показать онбординг-модалку «Вы не завершили настройку»: есть
 * подписка, но пользователь ни разу не подключался к VPN. При ошибке —
 * не показываем (не мешаем пользователю).
 */
export async function fetchSetupStatus(): Promise<SetupStatus> {
  try {
    return await appFetch<SetupStatus>("/setup-status");
  } catch {
    return { show_setup_prompt: false, has_subscription: false, ever_connected: null };
  }
}

export async function activateTrial(): Promise<{ success: boolean; message?: string }> {
  try {
    const r = await appFetch<{ success: boolean }>("/trial", { method: "POST" });
    return { success: !!r?.success };
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : "Ошибка" };
  }
}

// ── Вывод реферальных средств (USDT TON) ───────────────────

export type Withdrawal = {
  id: number;
  amount: number;
  address: string;
  status: "pending" | "approved" | "rejected";
  tx_link?: string | null;
  created_at?: string;
  processed_at?: string | null;
};

export async function fetchWithdrawals(): Promise<{ items: Withdrawal[]; min_withdraw: number }> {
  try {
    return await appFetch("/withdrawals");
  } catch {
    return { items: [], min_withdraw: 100 };
  }
}

export async function requestWithdraw(
  amount: number,
  address: string,
): Promise<{ success: boolean; partner_balance: number; withdrawal: Withdrawal }> {
  return appFetch("/withdraw", {
    method: "POST",
    body: JSON.stringify({ amount, address }),
  });
}

// ── Deep-links подписки в приложения (incy / happ / другое) ──

export type SubAppLink = { app: string; link: string; encrypted: boolean; open_url?: string };

export async function fetchAppLink(app: "incy" | "happ" | "other"): Promise<SubAppLink> {
  return appFetch<SubAppLink>(`/subscription/applink?app=${encodeURIComponent(app)}`);
}

/**
 * Открыть подписку в приложении. Telegram не открывает схемы incy:// / happ://
 * напрямую, поэтому сервер отдаёт https `open_url` (страница-редирект на сайте),
 * которую мы открываем через openLink. Для http-ссылок — тоже openLink.
 */
export function openDeepLink(res: SubAppLink | string): void {
  const link = typeof res === "string" ? res : (res.open_url || res.link);
  const isHttp = /^https?:\/\//i.test(link);
  const wa = tgWebApp();
  if (isHttp && wa?.openLink) {
    wa.openLink(link);
    return;
  }
  // Запасной путь (вне Telegram / нет https open_url)
  try {
    window.location.href = link;
  } catch {
    window.open(link, "_blank", "noopener,noreferrer");
  }
}
