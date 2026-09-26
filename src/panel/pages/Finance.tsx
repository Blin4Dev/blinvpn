import React, { useState, useEffect } from 'react';
import {
  ArrowUpRight, Activity,
} from 'lucide-react';
import { PageHead, Stat } from '../components/ui';
import { apiFetch, parseErr } from '../lib/api';
import { fmtDateTime, fmtInt, fmtMoney } from '../lib/format';
import type { PaymentRow, ToastType } from '../lib/types';

export const FinancePage: React.FC<{ onToast: (t: string, m: string, ty?: ToastType) => void; onOpenUser: (id: number) => void }> = ({ onToast, onOpenUser }) => {
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
