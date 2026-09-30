import React, { useState, useEffect } from 'react';
import {
  ArrowUpRight, Activity, Search,
} from 'lucide-react';
import { PaymentActions } from '../components/PaymentActions';
import { PageHead, PaymentStatusBadge, Stat, refundedRowStyle } from '../components/ui';
import { apiFetch } from '../lib/api';
import { fmtDateTime, fmtInt, fmtMoney } from '../lib/format';
import type { PaymentRow, ToastType } from '../lib/types';

export const FinancePage: React.FC<{ onToast: (t: string, m: string, ty?: ToastType) => void; onOpenUser: (id: number) => void }> = ({ onToast, onOpenUser }) => {
  const [stats, setStats] = useState<{ deposits: number; withdrawals: number; successfulOps: number } | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [q, setQ] = useState('');
  const loadPayments = async (query = q) => {
    try { setPayments((await apiFetch(`/panel/payments?limit=200${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ''}`)) || []); } catch { /* ignore */ }
  };
  useEffect(() => { (async () => { try { const d = await apiFetch('/panel/finance/stats'); if (d) setStats(d); } catch (e) { console.error(e); } })(); }, []);
  useEffect(() => { const t = setTimeout(() => void loadPayments(q), 300); return () => clearTimeout(t); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [q]);

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Финансы" sub="Доходы и операции" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Stat title="Пополнения" value={stats ? fmtMoney(stats.deposits) : '—'} icon={ArrowUpRight} />
        <Stat title="Успешные операции" value={stats ? fmtInt(stats.successfulOps) : '—'} sub="операций" icon={Activity} />
      </div>

      <div className="tbl-wrap">
        <div className="flex items-center justify-between gap-3" style={{ padding: '10px 14px', flexWrap: 'wrap' }}>
          <div className="sub" style={{ fontWeight: 600 }}>Платежи, возвраты и чарджбеки</div>
          <div className="search" style={{ minWidth: 280, flex: '0 1 380px' }}>
            <Search className="ico" size={16} />
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ID транзакции Platega, ID платежа, @username, ID…" />
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>Дата</th><th>Пользователь</th><th>Сумма</th><th>Способ</th><th>Статус</th><th></th></tr></thead>
            <tbody>
              {payments.length === 0 ? <tr className="empty-row"><td colSpan={6}>{q ? 'Ничего не найдено' : 'Пока нет платежей'}</td></tr>
                : payments.map((pm) => (
                  <tr key={String(pm.id)} style={refundedRowStyle(pm.status)}>
                    <td className="muted mono" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(pm.created_at)}</td>
                    <td className="click" onClick={() => pm.user_id && onOpenUser(Number(pm.user_id))}>{pm.username ? `@${pm.username}` : `#${pm.user_id}`}</td>
                    <td className="mono">
                      {pm.stars ? `${pm.stars} ⭐` : `${pm.amount ?? 0} ${pm.currency || ''}`}
                      {pm.referral_applied ? <span className="sub" style={{ marginLeft: 6 }}>+{pm.referral_applied}₽ реф.</span> : null}
                    </td>
                    <td className="sub" style={{ whiteSpace: 'nowrap' }} title={pm.provider_payment_id ? `ID платежа: ${pm.provider_payment_id}` : undefined}>{pm.method || pm.provider || '—'}</td>
                    <td><PaymentStatusBadge status={pm.status} />{pm.chargeback_reported && pm.status === 'paid' && <div className="badge danger" style={{ marginTop: 4 }}>пришёл чарджбек</div>}</td>
                    <td style={{ textAlign: 'right' }}><PaymentActions pm={pm} onToast={onToast} onDone={() => void loadPayments()} /></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
