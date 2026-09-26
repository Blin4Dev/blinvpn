import React, { useState, useEffect } from 'react';
import {
  X, CheckCircle, Ban, Clock, Copy, Send, RefreshCw,
} from 'lucide-react';
import { Modal, PageHead, Segmented, Spinner, Stat } from '../components/ui';
import { apiFetch, copyToClipboard, parseApiErr } from '../lib/api';
import { fmtDT, shortHash } from '../lib/format';
import type { ToastType } from '../lib/types';

export type WithdrawalStatus = 'pending' | 'approved' | 'completed' | 'rejected';

export type WithdrawalItem = {
  id: number; user_id: number; username?: string | null; telegram_id?: number | null; email?: string | null;
  amount: number; address: string; status: WithdrawalStatus;
  tx_hash?: string | null; reject_reason?: string | null; refunded?: boolean; is_banned?: boolean;
  created_at?: string; approved_at?: string | null; processed_at?: string | null;
};

export const WD_STATUS: Record<WithdrawalStatus, { label: string; cls: string; style?: React.CSSProperties }> = {
  pending: { label: 'Ожидает', cls: 'mute' },
  approved: { label: 'Одобрен', cls: 'line', style: { color: 'var(--text)', borderColor: 'var(--border-strong)' } },
  completed: { label: 'Завершено', cls: 'solid' },
  rejected: { label: 'Отклонён', cls: 'danger' },
};

export const WithdrawalsPage: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void; onOpenUser: (id: number) => void }> = ({ onToast, onOpenUser }) => {
  const [items, setItems] = useState<WithdrawalItem[]>([]);
  const [stats, setStats] = useState({ pc: 0, pa: 0, ac: 0, aa: 0, cc: 0, ca: 0 });
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | WithdrawalStatus>('all');
  const [pay, setPay] = useState<WithdrawalItem | null>(null);        // окно перевода (одобрен → завершить)
  const [hash, setHash] = useState('');
  const [reject, setReject] = useState<WithdrawalItem | null>(null);
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);

  const load = async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const d = await apiFetch('/panel/withdrawals');
      setItems(Array.isArray(d?.items) ? d.items : []);
      setStats({
        pc: Number(d?.pending_count || 0), pa: Number(d?.pending_amount || 0),
        ac: Number(d?.approved_count || 0), aa: Number(d?.approved_amount || 0),
        cc: Number(d?.completed_count || 0), ca: Number(d?.completed_amount || 0),
      });
    } catch { if (!quiet) onToast('Ошибка', 'Не удалось загрузить выводы', 'error'); }
    finally { if (!quiet) setLoading(false); }
  };
  useEffect(() => { load(); const t = setInterval(() => load(true), 20000); return () => clearInterval(t); }, []);

  const approve = async (w: WithdrawalItem) => {
    setBusy(w.id);
    try {
      const upd: WithdrawalItem = await apiFetch(`/panel/withdrawals/${w.id}/approve`, { method: 'POST' });
      onToast('Одобрено', 'Переведите средства на адрес и укажите hash транзакции', 'success');
      await load(true);
      setHash(''); setPay(upd || { ...w, status: 'approved' });
    } catch (e: any) { onToast('Ошибка', parseApiErr(e, 'Не удалось одобрить'), 'error'); }
    finally { setBusy(null); }
  };
  const complete = async () => {
    if (!pay) return;
    if (!hash.trim()) { onToast('Ошибка', 'Укажите hash транзакции', 'error'); return; }
    setBusy(pay.id);
    try {
      const r = await apiFetch(`/panel/withdrawals/${pay.id}/complete`, { method: 'POST', body: JSON.stringify({ tx_hash: hash.trim() }) });
      onToast('Завершено', r?.notified === false ? 'Вывод завершён. Сообщение пользователю не доставлено (нет Telegram или бот заблокирован).' : 'Вывод завершён, пользователь получил hash в Telegram', 'success');
      setPay(null); setHash(''); load(true);
    } catch (e: any) { onToast('Ошибка', parseApiErr(e, 'Не удалось завершить'), 'error'); }
    finally { setBusy(null); }
  };
  const doReject = async () => {
    if (!reject) return;
    if (!reason.trim()) { onToast('Ошибка', 'Укажите причину отказа', 'error'); return; }
    setBusy(reject.id);
    try {
      await apiFetch(`/panel/withdrawals/${reject.id}/reject`, { method: 'POST', body: JSON.stringify({ reason: reason.trim(), refund }) });
      onToast('Отклонено', refund ? 'Сумма возвращена на реферальный баланс' : 'Средства не возвращены', 'success');
      setReject(null); setReason(''); setRefund(true); load(true);
    } catch (e: any) { onToast('Ошибка', parseApiErr(e, 'Не удалось отклонить'), 'error'); }
    finally { setBusy(null); }
  };
  const copy = async (text: string, what: string) => { if (await copyToClipboard(text)) onToast('Скопировано', what, 'success'); };

  const who = (w: WithdrawalItem) => (w.username ? `@${w.username}` : w.email || `id${w.user_id}`);
  const shown = filter === 'all' ? items : items.filter((w) => w.status === filter);
  const fmtRub = (v: number) => `${Number.isInteger(v) ? v : v.toFixed(2)} ₽`;

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Выводы" sub="Заявки на вывод реферальных средств (USDT TON). В форум приходит только уведомление — обработка здесь." />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Stat title="Ожидают решения" value={String(stats.pc)} sub={`${fmtRub(stats.pa)} заморожено`} icon={Clock} />
        <Stat title="Одобрены — к переводу" value={String(stats.ac)} sub={fmtRub(stats.aa)} icon={Send} />
        <Stat title="Выплачено" value={fmtRub(stats.ca)} sub={`${stats.cc} заявок`} icon={CheckCircle} />
      </div>

      <div className="tbl-wrap">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3" style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
          <Segmented value={filter} onChange={setFilter} options={[
            { value: 'all', label: 'Все' }, { value: 'pending', label: 'Ожидают' }, { value: 'approved', label: 'Одобрены' },
            { value: 'completed', label: 'Завершены' }, { value: 'rejected', label: 'Отклонены' },
          ]} />
          <button className="btn sm" onClick={() => load()}><RefreshCw size={14} /> Обновить</button>
        </div>
        {loading ? <div className="sub" style={{ padding: 32, textAlign: 'center' }}>Загрузка…</div>
          : shown.length === 0 ? <div className="sub" style={{ padding: 32, textAlign: 'center' }}>Заявок нет</div>
          : <div style={{ overflowX: 'auto' }}><table className="tbl" style={{ minWidth: 860 }}>
              <thead><tr><th>#</th><th>Пользователь</th><th>Сумма</th><th>Статус</th><th>Создана</th><th>Итог</th><th style={{ textAlign: 'right' }}>Действия</th></tr></thead>
              <tbody>{shown.map((w) => {
                const st = WD_STATUS[w.status] || WD_STATUS.pending;
                return (
                  <tr key={w.id}>
                    <td className="muted">{w.id}</td>
                    <td>
                      <button className="btn ghost sm" style={{ padding: 0, color: 'var(--text)' }} onClick={() => onOpenUser(w.user_id)}>{who(w)}</button>
                      {w.is_banned && <span className="badge danger" style={{ marginLeft: 8 }}>бан</span>}
                    </td>
                    <td style={{ fontWeight: 600 }}>{fmtRub(w.amount)}</td>
                    <td><span className={`badge ${st.cls}`} style={st.style}>{st.label}</span></td>
                    <td className="muted" style={{ fontSize: 13 }}>{fmtDT(w.created_at)}</td>
                    <td style={{ fontSize: 13, maxWidth: 260 }}>
                      {w.status === 'completed' && w.tx_hash ? (
                        <button className="btn ghost sm mono" style={{ padding: 0 }} title="Скопировать hash" onClick={() => copy(w.tx_hash!, 'Hash транзакции')}><Copy size={13} /> {shortHash(w.tx_hash)}</button>
                      ) : w.status === 'rejected' ? (
                        <span className="muted">{w.reject_reason || 'Без причины'} · {w.refunded ? 'возвращено' : 'не возвращено'}</span>
                      ) : w.status === 'approved' ? (
                        <span className="muted">одобрено {fmtDT(w.approved_at)}</span>
                      ) : <span className="faint">—</span>}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {w.status === 'pending' && (
                        <span className="inline-flex gap-2">
                          <button className="btn sm solid" disabled={busy === w.id} onClick={() => approve(w)}>{busy === w.id ? <Spinner size={14} /> : 'Одобрить'}</button>
                          <button className="btn sm" onClick={() => { setReject(w); setReason(''); setRefund(true); }}>Отклонить</button>
                        </span>
                      )}
                      {w.status === 'approved' && (
                        <span className="inline-flex gap-2">
                          <button className="btn sm solid" onClick={() => { setPay(w); setHash(''); }}><Send size={14} /> Перевести</button>
                          <button className="btn sm" onClick={() => { setReject(w); setReason(''); setRefund(true); }}>Отклонить</button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table></div>}
      </div>

      {pay && (
        <Modal onClose={() => setPay(null)} title={`Вывод #${pay.id} — перевод`} icon={Send} width={500}
          footer={<><button className="btn block" onClick={() => setPay(null)}>Позже</button><button className="btn solid block" onClick={complete} disabled={busy === pay.id || !hash.trim()}>{busy === pay.id ? <Spinner size={16} /> : 'Завершить'}</button></>}>
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="inset" style={{ padding: 12 }}><div className="sub">Пользователь</div><div style={{ fontWeight: 500, marginTop: 2 }}>{who(pay)}</div></div>
              <div className="inset" style={{ padding: 12 }}><div className="sub">Сумма к переводу</div><div style={{ fontWeight: 600, fontSize: 18, marginTop: 2 }}>{fmtRub(pay.amount)}</div></div>
            </div>
            <div>
              <label className="field-label">Адрес для перевода (USDT TON)</label>
              <div className="flex gap-2">
                <div className="input mono" style={{ fontSize: 13, wordBreak: 'break-all', height: 'auto', minHeight: 40, lineHeight: 1.45, padding: '9px 12px', userSelect: 'all' }}>{pay.address}</div>
                <button className="icon-btn" style={{ flex: 'none', height: 'auto' }} title="Скопировать адрес" onClick={() => copy(pay.address, 'Адрес для перевода')}><Copy size={15} /></button>
              </div>
            </div>
            <div>
              <label className="field-label">Hash транзакции</label>
              <input className="input mono" value={hash} onChange={(e) => setHash(e.target.value)} placeholder="Вставьте hash после перевода" autoFocus />
            </div>
            <div className="sub" style={{ fontSize: 12 }}>После «Завершить» статус станет «Завершено», а пользователь получит сообщение в Telegram с этим hash.</div>
          </div>
        </Modal>
      )}

      {reject && (
        <Modal onClose={() => setReject(null)} title={`Отклонить вывод #${reject.id}`} icon={Ban} width={480}
          footer={<><button className="btn block" onClick={() => setReject(null)}>Отмена</button><button className="btn danger block" onClick={doReject} disabled={busy === reject.id || !reason.trim()}>{busy === reject.id ? <Spinner size={16} /> : 'Отклонить'}</button></>}>
          <div className="flex flex-col gap-4">
            <div className="inset" style={{ padding: 12, fontSize: 13 }}>{who(reject)} · <b>{fmtRub(reject.amount)}</b></div>
            <div>
              <label className="field-label">Причина отказа</label>
              <textarea className="textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Например: неверный адрес кошелька" autoFocus />
              <div className="sub mt-1" style={{ fontSize: 12 }}>Пользователь получит её в Telegram.</div>
            </div>
            <div>
              <label className="field-label">Деньги</label>
              <div className="flex flex-col gap-2">
                <button type="button" className={`chip ${refund ? 'on' : ''}`} style={{ justifyContent: 'flex-start', padding: '10px 12px' }} onClick={() => setRefund(true)}>
                  <CheckCircle size={15} /> Вернуть деньги на баланс
                </button>
                <button type="button" className={`chip ${!refund ? 'on' : ''}`} style={{ justifyContent: 'flex-start', padding: '10px 12px' }} onClick={() => setRefund(false)}>
                  <X size={15} /> Не возвращать
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};
