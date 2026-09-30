import React, { useState } from 'react';
import { RotateCcw, ShieldAlert, Undo2 } from 'lucide-react';
import { DotsMenu, Modal, Spinner, Toggle } from './ui';
import { apiFetch, parseErr } from '../lib/api';
import type { PaymentRow, ToastType } from '../lib/types';

// refund через platega/stars; chargeback только откат (деньги уже вернул банк)
export const PaymentActions: React.FC<{ pm: PaymentRow; onDone: () => void; onToast: (t: string, m: string, ty?: ToastType) => void }> = ({ pm, onDone, onToast }) => {
  const [ask, setAsk] = useState<'' | 'refund' | 'chargeback'>('');
  const [busy, setBusy] = useState(false);
  const [ban, setBan] = useState(false);
  const [note, setNote] = useState('');
  if (!pm.payment_id || typeof pm.id !== 'number') return null;
  const amount = pm.stars ? `${pm.stars} ⭐` : `${pm.amount ?? 0} ₽`;
  const run = async () => {
    setBusy(true);
    try {
      const url = `/panel/payments/${encodeURIComponent(String(pm.payment_id))}/${ask}`;
      const body = ask === 'chargeback' ? { ban, note: note.trim() } : {};
      const r = await apiFetch(url, { method: 'POST', body: JSON.stringify(body) });
      if (r && r.ok) onToast(ask === 'refund' ? 'Возврат' : 'Чарджбек', (r.message || 'Готово') + (r.manual ? ' (ручной контроль)' : ''), 'success');
      else onToast(ask === 'refund' ? 'Возврат' : 'Чарджбек', (r && r.message) || 'Не удалось', 'error');
      setAsk(''); onDone();
    } catch (e) { onToast('Ошибка', parseErr(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <>
      <DotsMenu items={[
        { label: 'Возврат', icon: Undo2, onClick: () => setAsk('refund'), disabled: !pm.refundable,
          hint: pm.chargeback_reported ? 'Пришёл чарджбек — возврат запрещён' : pm.status !== 'paid' ? 'Платёж уже не активен' : 'Недоступно для этого платежа' },
        { label: 'Чарджбек', icon: ShieldAlert, danger: true, onClick: () => { setBan(false); setNote(''); setAsk('chargeback'); }, disabled: !pm.can_chargeback, hint: 'Только для оплаченного платежа' },
      ]} />
      {ask && (
        <Modal onClose={() => !busy && setAsk('')} title={ask === 'refund' ? 'Возврат денег' : 'Чарджбек'} icon={ask === 'refund' ? RotateCcw : ShieldAlert} width={480}
          footer={<><button className="btn" disabled={busy} onClick={() => setAsk('')}>Отмена</button>
            <button className={`btn ${ask === 'chargeback' ? 'danger' : 'solid'}`} disabled={busy} onClick={run}>
              {busy ? <Spinner size={15} /> : null} {ask === 'refund' ? `Вернуть ${amount}` : 'Провести чарджбек'}</button></>}>
          <div className="flex flex-col gap-3" style={{ fontSize: 14, lineHeight: 1.5 }}>
            <div className="sub">Платёж <span className="mono">{pm.payment_id}</span>{pm.provider_payment_id ? <> · Platega <span className="mono">{pm.provider_payment_id}</span></> : null} · {amount}</div>
            {ask === 'refund' ? (<>
              <div>Деньги вернутся пользователю через {pm.provider === 'tg_stars' ? 'Telegram Stars' : 'Platega'}. Подписка по этому платежу откатится, реферальный бонус пригласившего будет снят.</div>
              <div className="badge danger" style={{ whiteSpace: 'normal' }}>Если по платежу пришёл чарджбек — не делайте возврат, нажмите «Чарджбек».</div>
            </>) : (<>
              <div>Банк уже вернул деньги пользователю. Здесь <b>деньги не возвращаются</b> — откатываются только последствия этого платежа:</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li>подписка: снимаются ещё не прошедшие дни этого платежа и его устройства; дни и устройства, оплаченные после него, остаются (если оплаченного времени не останется — подписка отзывается);</li>
                <li>реферальный бонус пригласившего снимается;</li>
                <li>платёж помечается «Чарджбек».</li>
              </ul>
              <label className="flex items-center justify-between gap-3" style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, cursor: 'pointer' }}>
                <span>
                  <div style={{ fontWeight: 500 }}>Заблокировать пользователя</div>
                  <div className="sub" style={{ fontSize: 12 }}>Аккаунт будет забанен, причина — «Чарджбек по платежу …»</div>
                </span>
                <Toggle on={ban} onChange={() => setBan(!ban)} />
              </label>
              <input className="input" placeholder="Комментарий (необязательно)" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
            </>)}
          </div>
        </Modal>
      )}
    </>
  );
};
