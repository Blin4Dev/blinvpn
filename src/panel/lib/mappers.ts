import type { User, UserStatus } from './types';

export function mapApiUser(u: any): User {
  return {
    id: u.id,
    telegramId: u.telegram_id,
    username: u.username ? (String(u.username).startsWith('@') ? u.username : `@${u.username}`) : `id${u.telegram_id}`,
    balance: u.balance ?? 0,
    status: (u.in_blacklist || u.is_banned) ? 'Banned' : ((u.status as UserStatus) || 'None'),
    regDate: u.registration_date ? new Date(u.registration_date).toLocaleDateString('ru-RU') : '',
    paidUntil: u.paid_until ? new Date(u.paid_until).toLocaleDateString('ru-RU') : '—',
    refCode: u.referral_code || '',
    isPartner: !!u.is_partner,
    partnerBalance: u.partner_balance ?? 0,
    partnerRate: u.partner_rate ?? 25,
    referrals: u.referrals ?? 0,
    inBlacklist: !!u.in_blacklist,
    revenue: Number(u.revenue ?? 0),
    noRenew: !!u.no_renew,
  };
}
