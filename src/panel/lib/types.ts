

export type ToastType = 'success' | 'error' | 'info';

export type TransactionType = 'income' | 'expense';

export type UserStatus = 'Active' | 'Trial' | 'Banned' | 'Expired' | 'None';

export type KeyStatus = 'Deleted' | 'Active' | 'Expired' | 'Banned' | 'Blocked';

export interface Toast { id: number; title: string; message?: string; type: ToastType; }

export interface Transaction {
  id: number; user: string; amount: number; type: TransactionType;
  status: string; method: string; date: string; hash: string;
}

export interface User {
  id: number; telegramId: number; username: string; balance: number; status: UserStatus;
  regDate: string; paidUntil: string; refCode: string; isPartner: boolean;
  partnerBalance: number; partnerRate: number;
  referrals: number; inBlacklist: boolean; revenue: number; noRenew: boolean;
}

export interface KeyItem {
  id: number; key: string; user: string; status: KeyStatus; expiry: number;
  trafficUsed: number; trafficLimit: number; devicesUsed: number; devicesLimit: number;
}

export interface Promo {
  id: number; code: string; name: string; value: string; uses: number; limit: number; expires: string;
}

export interface TrackingLink {
  id: number; code: string; name: string; promocode: string | null; welcome_message: string | null;
  url: string; clicks: number; is_active: boolean; created_at: string; unique_users: number;
  new_users: number; total_revenue: number; paid_users: number; active_subscriptions: number;
  total_keys: number; conversion_rate: number;
}

export interface TrackingLinkUser {
  user_id: number; telegram_id: number; username: string | null; full_name: string | null;
  is_new_user: boolean; visited_at: string; trial_used: boolean; total_spent: number;
  keys_count: number; active_keys: number; has_paid: boolean;
}

export interface PaymentRow { id: any; payment_id?: string | null; user_id?: number | null; username?: string | null; telegram_id?: number | null; provider: string | null; method: string | null; amount: number | null; currency: string | null; stars: number | null; status: string | null; purpose: string | null; description?: string | null; created_at: string | null; paid_at: string | null; refundable?: boolean; refunded_at?: string | null; referral_applied?: number | null; }
