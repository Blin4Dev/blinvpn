import React, { useState, useEffect } from 'react';
import {
  Key, Gift, Percent, X, CheckCircle, CreditCard, ArrowUpRight, ArrowDownLeft, Hash, Ban, Clock, Edit2, Copy, Database, Wallet, Plus, Send, Trash2, Save, RefreshCw, Shield, ArrowLeft, ClipboardList, ExternalLink,
  AlertTriangle,
} from 'lucide-react';
import { UserActionModal } from '../../components/UserActionModal';
import { DCard, InfoRow, Modal, PaymentStatusBadge, Spinner, refundedRowStyle } from '../../components/ui';
import { apiFetch, copyToClipboard, mergeInfo, parseErr } from '../../lib/api';
import { DEFAULT_REF_RATE, fmtDateTime, relTime, whenRu } from '../../lib/format';
import type { PaymentRow, ToastType } from '../../lib/types';
import { ExchangeModal, TransferModal } from './SubscriptionActions';

export interface UserDetailData {
  id: number; telegram_id: number | null; username: string | null;
  first_name: string | null; last_name: string | null; email: string | null;
  registration_date: string | null; status: string; is_banned: boolean; key_blocked?: boolean; ban_reason?: string | null; blacklist_reason?: string | null; blacklist_ignored?: boolean;
  subscriptions_history?: { id: number; status: string; type?: string; expiry_date?: string | null; created_at?: string | null; deleted_at?: string | null; devices_limit?: number }[];
  balance: number; partner_rate: number;
  partner_balance: number; is_partner: boolean; has_trial: boolean;
  referrals: { id: number; telegram_id: number | null; username: string | null; email: string | null; full_name: string | null }[];
  subscription: any | null;
  discount?: { percent: number; expires_at: string | null; code: string | null; name: string | null } | null;
  promo_activations?: { id: number; code: string | null; name: string | null; discount_percent: number; expires_at: string | null; created_at: string | null; active: boolean }[];
}

export interface UserSurveyAnswer { n: number; q: string; answers: string[]; }

export interface UserSurvey { taken: boolean; completed?: boolean; started_at?: string | null; completed_at?: string | null; answers: UserSurveyAnswer[]; }

export interface RwDevice { hwid: string; platform: string | null; os_version: string | null; device_model: string | null; user_agent: string | null; created_at: string | null; updated_at: string | null; }

export interface RwInfo { configured: boolean; found: boolean; online_at: string | null; first_connected_at: string | null; last_user_agent: string | null; status: string | null; used_traffic_bytes: number | null; traffic_limit_bytes: number | null; expire_at: string | null; hwid_device_limit: number | null; subscription_url: string | null; devices: RwDevice[]; error: string | null; }

export const STATUS_META: Record<string, { label: string; cls: string }> = {
  trial:   { label: 'Пробная подписка', cls: 'mute' },
  active:  { label: 'Платная подписка', cls: 'solid' },
  expired: { label: 'Истекла', cls: 'line' },
  lapsed:  { label: 'Истекла', cls: 'line' },
  never:   { label: 'Никогда не было подписки', cls: 'line' },
  banned:  { label: 'Заблокирован', cls: 'danger' },
  blocked: { label: 'Ключ заблокирован', cls: 'danger' },
};

export const UserDetailPage: React.FC<{
  userId: number; onBack: () => void; onToast: (t: string, m: string, ty?: ToastType) => void; onOpenUser: (id: number) => void;
}> = ({ userId, onBack, onToast, onOpenUser }) => {
  const [detail, setDetail] = useState<UserDetailData | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [rw, setRw] = useState<RwInfo | null>(null);
  const [survey, setSurvey] = useState<UserSurvey | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [editTg, setEditTg] = useState(false);
  const [editEmail, setEditEmail] = useState(false);
  const [tgDraft, setTgDraft] = useState('');
  const [emailDraft, setEmailDraft] = useState('');
  const [promoDraft, setPromoDraft] = useState('');
  const [special, setSpecial] = useState<'' | 'exchange' | 'transfer'>('');
  // Привязка email/Telegram, который уже есть у другого аккаунта: предупреждение об объединении
  const [mergeAsk, setMergeAsk] = useState<{ act: string; value: any; message: string; merge: any } | null>(null);

  const load = async () => {
    try { setDetail(await apiFetch(`/panel/users/${userId}/detail`)); }
    catch (e) { onToast('Ошибка', parseErr(e), 'error'); }
    finally { setLoading(false); }
  };
  const loadPayments = async () => { try { setPayments((await apiFetch(`/panel/users/${userId}/payments`)) || []); } catch { /* ignore */ } };
  const loadRw = async () => { try { setRw(await apiFetch(`/panel/users/${userId}/remnawave`)); } catch { /* ignore */ } };
  const loadSurvey = async () => { try { setSurvey(await apiFetch(`/panel/users/${userId}/survey`)); } catch { /* ignore */ } };

  const doRefund = async (pm: PaymentRow) => {
    if (!pm.payment_id || busy) return;
    if (!window.confirm(`Вернуть средства по платежу на ${pm.amount} ₽ через Platega?\nПодписка будет отозвана, реферальный бонус аплайна снят.`)) return;
    setBusy(true);
    try {
      const r = await apiFetch(`/panel/payments/${encodeURIComponent(pm.payment_id)}/refund`, { method: 'POST' });
      if (r && r.ok) onToast('Возврат', (r.message || 'Возврат отправлен') + (r.manual ? ' (ручной контроль)' : ''), 'success');
      else onToast('Возврат', (r && r.message) || 'Не удалось выполнить возврат', 'error');
      await loadPayments(); await load();
    } catch (e) { onToast('Ошибка', parseErr(e), 'error'); }
    finally { setBusy(false); }
  };

  useEffect(() => { setLoading(true); setRw(null); setSurvey(null); void load(); void loadPayments(); void loadRw(); void loadSurvey(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [userId]);

  const doAction = async (act: string, value: any = null, notify = false, confirmMsg?: string, confirm = false) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/panel/users/${userId}/action`, { method: 'POST', body: JSON.stringify({ action: act, value, notify, confirm }) });
      if (res && res.deleted) { onToast('Готово', 'Аккаунт удалён', 'success'); onBack(); return; }
      onToast('Готово', confirm ? 'Аккаунты объединены' : 'Действие выполнено', 'success');
      await load(); await loadPayments(); await loadRw();
    } catch (e) {
      const m = mergeInfo(e);
      if (m) setMergeAsk({ act, value, ...m });
      else onToast('Ошибка', parseErr(e), 'error');
    }
    finally { setBusy(false); }
  };

  const unlinkDevice = async (hwid: string) => {
    if (!window.confirm('Отвязать это устройство?')) return;
    try { await apiFetch(`/panel/users/${userId}/hwid/unlink`, { method: 'POST', body: JSON.stringify({ hwid }) }); onToast('Готово', 'Устройство отвязано', 'success'); await loadRw(); }
    catch (e) { onToast('Ошибка', parseErr(e), 'error'); }
  };

  const unlinkReferral = async (refId: number) => {
    try { await apiFetch(`/panel/users/${userId}/referrals/${refId}/unlink`, { method: 'POST' }); onToast('Готово', 'Реферал отвязан', 'success'); await load(); }
    catch (e) { onToast('Ошибка', parseErr(e), 'error'); }
  };

  if (loading) return <div style={{ padding: 60, display: "flex", justifyContent: "center" }}><Spinner size={22} /></div>;
  if (!detail) return (
    <div className="flex flex-col gap-4">
      <button className="btn" onClick={onBack}><ArrowLeft size={16} /> Назад</button>
      <div className="muted">Пользователь не найден.</div>
    </div>
  );

  const uname = detail.username ? `@${detail.username}` : (detail.telegram_id ? `id${detail.telegram_id}` : `#${detail.id}`);
  const stMeta = detail.key_blocked ? STATUS_META.blocked : detail.is_banned ? STATUS_META.banned : (STATUS_META[detail.status] || STATUS_META.never);
  const sub = detail.subscription;
  // Ссылка на подписку: из БД, а если там пусто — из Remnawave
  const subLink: string = (sub?.key_config && /^https?:\/\//.test(String(sub.key_config)) ? String(sub.key_config) : '') || rw?.subscription_url || '';
  const fullName = [detail.first_name, detail.last_name].filter(Boolean).join(' ');

  return (
    <div className="flex flex-col gap-5">
      {action && (
        <UserActionModal type={action} onClose={() => setAction(null)}
          onConfirm={(value, notify) => { const a = action; setAction(null); void doAction(a, value, notify); }} />
      )}

      <div className="flex items-center justify-between gap-3">
        <button className="btn" onClick={onBack}><ArrowLeft size={16} /> К пользователям</button>
        <div className="flex items-center gap-2">
          {detail.key_blocked
            ? <button className="btn" disabled={busy} onClick={() => void doAction('UNBLOCK_KEY', null, false)}><CheckCircle size={15} /> Разблокировать ключ</button>
            : <button className="btn danger" disabled={busy} onClick={() => void doAction('BLOCK_KEY', null, false, 'Заблокировать ключ (подписку) пользователя?')}><Ban size={15} /> Заблокировать ключ</button>}
          <button className="btn danger" disabled={busy} onClick={() => void doAction('DELETE_USER', null, false, 'Удалить аккаунт безвозвратно из базы и Remnawave?')}><Trash2 size={15} /> Удалить</button>
        </div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <div className="flex items-center gap-3">
          <span className="avatar" style={{ width: 48, height: 48, fontSize: 16 }}>{uname.replace('@', '').slice(0, 2).toUpperCase()}</span>
          <div className="flex-1">
            <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
              <span className="h-sec" style={{ fontSize: 18 }}>{uname}</span>
              <span className={`badge ${stMeta.cls}`}>{stMeta.label}</span>
              {Number(detail.partner_rate ?? DEFAULT_REF_RATE) !== DEFAULT_REF_RATE && <span className="badge mute" title="Индивидуальный процент реферальной программы">Реф. {detail.partner_rate}%</span>}
              {sub?.no_renew && <span className="badge line">Без продления</span>}
            </div>
            {fullName && <div className="sub">{fullName}</div>}
            {detail.is_banned && detail.ban_reason && <div className="sub" style={{ color: 'var(--danger)' }}>Причина блокировки: {detail.ban_reason}</div>}
            {!detail.is_banned && detail.blacklist_ignored && detail.blacklist_reason != null && <div className="sub">В общем чёрном списке ({detail.blacklist_reason || 'без причины'}) — разблокирован вручную</div>}
          </div>
          <button className="btn solid" onClick={() => setAction('NOTIFY')}><Send size={15} /> Написать</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <DCard title="Профиль" icon={Hash}>
          <InfoRow label="Внутренний ID"><span className="mono">{detail.id}</span></InfoRow>
          <InfoRow label="Telegram ID">
            {editTg ? (
              <>
                <input className="input mono sm" style={{ width: 150 }} value={tgDraft} onChange={(e) => setTgDraft(e.target.value)} placeholder="123456789" />
                <button className="icon-btn" title="Сохранить" onClick={async () => { await doAction('SET_TELEGRAM_ID', tgDraft); setEditTg(false); }}><Save size={15} /></button>
                <button className="icon-btn" title="Отмена" onClick={() => setEditTg(false)}><X size={15} /></button>
              </>
            ) : (
              <>
                <span className="mono">{detail.telegram_id ?? '—'}</span>
                <button className="icon-btn" title={detail.telegram_id ? 'Изменить' : 'Привязать'} onClick={() => { setTgDraft(String(detail.telegram_id ?? '')); setEditTg(true); }}><Edit2 size={14} /></button>
                {detail.telegram_id && detail.email && <button className="btn sm danger" onClick={() => void doAction('UNBIND_TELEGRAM', null, false, 'Отвязать Telegram от аккаунта?')}>Отвязать</button>}
              </>
            )}
          </InfoRow>
          <InfoRow label="Email">
            {editEmail ? (
              <>
                <input className="input mono sm" style={{ width: 190 }} value={emailDraft} onChange={(e) => setEmailDraft(e.target.value)} placeholder="user@mail.com" />
                <button className="icon-btn" title="Сохранить" onClick={async () => { await doAction('SET_EMAIL', emailDraft); setEditEmail(false); }}><Save size={15} /></button>
                <button className="icon-btn" title="Отмена" onClick={() => setEditEmail(false)}><X size={15} /></button>
              </>
            ) : (
              <>
                <span className="mono">{detail.email ?? '—'}</span>
                <button className="icon-btn" title={detail.email ? 'Изменить' : 'Привязать'} onClick={() => { setEmailDraft(detail.email ?? ''); setEditEmail(true); }}><Edit2 size={14} /></button>
                {detail.email && detail.telegram_id && <button className="btn sm danger" onClick={() => void doAction('UNBIND_EMAIL', null, false, 'Отвязать email от аккаунта?')}>Отвязать</button>}
              </>
            )}
          </InfoRow>
          <InfoRow label="Регистрация"><span className="mono">{fmtDateTime(detail.registration_date)}</span></InfoRow>
          <InfoRow label="Статус"><span className={`badge ${stMeta.cls}`}>{stMeta.label}</span></InfoRow>
          <div className="flex gap-2 mt-3">
            <button className="btn sm" disabled={!detail.has_trial} onClick={() => void doAction('RESET_TRIAL', null, false, 'Сбросить пробный период? Пользователь сможет активировать его заново.')}><RefreshCw size={14} /> Сбросить триал</button>
          </div>
        </DCard>

        <DCard title="Реферальная программа" icon={Percent}>
          <InfoRow label="Процент реферала"><span className="mono">{detail.partner_rate}%</span><button className="icon-btn" title="Изменить" onClick={() => setAction('SET_PARTNER_RATE')}><Edit2 size={14} /></button></InfoRow>
          <InfoRow label="Реферальный баланс">
            <span className="mono">{detail.partner_balance} ₽</span>
            <button className="icon-btn" title="Начислить" onClick={() => setAction('ADD_PARTNER_BALANCE')}><Plus size={14} /></button>
            <button className="icon-btn" title="Списать" onClick={() => setAction('SUB_PARTNER_BALANCE')}><ArrowDownLeft size={14} /></button>
            <button className="icon-btn" title="Установить" onClick={() => setAction('SET_PARTNER_BALANCE')}><Wallet size={14} /></button>
          </InfoRow>
          <div className="mt-3">
            <div className="sub mb-2">Рефералы ({detail.referrals.length})</div>
            {detail.referrals.length === 0 ? <div className="muted sm">Нет рефералов</div> : (
              <div className="flex flex-col gap-1">
                {detail.referrals.map((r) => (
                  <div key={r.id} className="inset flex items-center justify-between" style={{ padding: '8px 10px' }}>
                    <button className="btn sm" style={{ background: 'transparent', border: 'none', padding: 0 }} onClick={() => onOpenUser(r.id)}>{r.username ? `@${r.username}` : (r.telegram_id ? `id${r.telegram_id}` : `#${r.id}`)}</button>
                    <button className="icon-btn danger" title="Отвязать" onClick={() => void unlinkReferral(r.id)}><X size={14} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DCard>
      </div>

      <DCard title="Скидка / Промокод" icon={Gift}>
        {detail.discount ? (
          <InfoRow label="Активная скидка">
            <span style={{ fontWeight: 700, color: 'var(--accent, #F18726)' }}>{detail.discount.percent}%</span>
            <span className="sub">{detail.discount.code}{detail.discount.name ? ` · ${detail.discount.name}` : ''}</span>
            <span className="sub">до {fmtDateTime(detail.discount.expires_at)}</span>
            <button className="btn sm danger" disabled={busy} onClick={() => void doAction('REMOVE_PROMO', detail.discount?.code || null, false, 'Снять скидку у пользователя?')}>Снять</button>
          </InfoRow>
        ) : (
          <div className="muted sm" style={{ marginBottom: 10 }}>Активной скидки нет.</div>
        )}
        <div className="flex items-center gap-2 mt-3" style={{ flexWrap: 'wrap' }}>
          <input className="input mono sm" style={{ width: 170 }} value={promoDraft} onChange={(e) => setPromoDraft(e.target.value.toUpperCase())} placeholder="ПРОМОКОД" />
          <button className="btn sm solid" disabled={busy || !promoDraft.trim()} onClick={async () => { await doAction('APPLY_PROMO', promoDraft.trim()); setPromoDraft(''); }}>Выдать промокод</button>
        </div>
        {detail.promo_activations && detail.promo_activations.length > 0 && (
          <div className="mt-3">
            <div className="sub mb-2">История активаций</div>
            <div className="flex flex-col gap-1">
              {detail.promo_activations.map((a) => (
                <div key={a.id} className="inset flex items-center justify-between" style={{ padding: '8px 10px' }}>
                  <span className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
                    <span className="mono">{a.code}</span>
                    <span style={{ fontWeight: 600 }}>{a.discount_percent}%</span>
                    <span className={`badge ${a.active ? 'solid' : 'line'}`}>{a.active ? 'активна' : 'истекла'}</span>
                    <span className="sub">до {fmtDateTime(a.expires_at)}</span>
                  </span>
                  {a.active && <button className="icon-btn danger" title="Снять" disabled={busy} onClick={() => void doAction('REMOVE_PROMO', a.code || null)}><X size={14} /></button>}
                </div>
              ))}
            </div>
          </div>
        )}
      </DCard>

      {mergeAsk && (
        <Modal onClose={() => setMergeAsk(null)} title="Объединить аккаунты?" icon={AlertTriangle} width={520}
          footer={<><button className="btn" onClick={() => setMergeAsk(null)}>Отмена</button>
            <button className="btn solid" disabled={busy} onClick={async () => { const a = mergeAsk; setMergeAsk(null); await doAction(a.act, a.value, false, undefined, true); }}>Объединить</button></>}>
          <div className="sub" style={{ marginBottom: 12 }}>
            {mergeAsk.message}. Второй аккаунт — <b style={{ color: 'var(--text)' }}>{mergeAsk.merge.other?.label}</b> (#{mergeAsk.merge.other?.id}).
          </div>
          <div className="inset" style={{ padding: 14, whiteSpace: 'pre-line', lineHeight: 1.6, fontSize: 14 }}>{mergeAsk.merge.text}</div>
        </Modal>
      )}
      {special === 'exchange' && sub && <ExchangeModal userId={userId} current={sub.devices_limit ?? 1} onClose={() => setSpecial('')} onDone={() => { setSpecial(''); void load(); void loadRw(); }} onToast={onToast} />}
      {special === 'transfer' && <TransferModal userId={userId} onClose={() => setSpecial('')} onDone={(tid) => { setSpecial(''); if (window.confirm('Подписка перенесена. Открыть карточку получателя?')) onOpenUser(tid); else { void load(); void loadRw(); } }} onToast={onToast} />}
      <DCard title="Подписка" icon={Key}>
        {!sub ? <div className="muted sm">Активной подписки нет.</div> : (
          <>
            <InfoRow label="Действует до">
              <span className="mono">{fmtDateTime(sub.expiry_date)}</span>
              {typeof sub.days_left === 'number' && <span className="sub">({sub.days_left} дн.)</span>}
            </InfoRow>
            <InfoRow label="Срок">
              <button className="btn sm solid" onClick={() => setAction('EXTEND_SUB')}><Plus size={14} /> Продлить</button>
              <button className="btn sm" onClick={() => setAction('REDUCE_SUB')}>Уменьшить</button>
            </InfoRow>
            <InfoRow label="Трафик (ГБ)">
              <span className="mono">{sub.traffic_used ?? 0} / {sub.traffic_limit ? sub.traffic_limit : '∞'}</span>
              <button className="icon-btn" title="Добавить" onClick={() => setAction('ADD_TRAFFIC')}><Plus size={14} /></button>
              <button className="icon-btn" title="Убавить" onClick={() => setAction('SUB_TRAFFIC')}><ArrowDownLeft size={14} /></button>
              <button className="icon-btn" title="Установить лимит" onClick={() => setAction('SET_TRAFFIC')}><Database size={14} /></button>
            </InfoRow>
            <InfoRow label="Ссылка на подписку">
              {subLink ? (
                <>
                  <span className="mono sub" style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }} title={subLink}>
                    {subLink.replace(/^https?:\/\//, '')}
                  </span>
                  <button className="btn sm" onClick={async () => { if (await copyToClipboard(subLink)) onToast('Скопировано', 'Ссылка на подписку', 'success'); }}>
                    <Copy size={14} /> Копировать
                  </button>
                  <a className="icon-btn" href={subLink} target="_blank" rel="noreferrer" title="Открыть"><ExternalLink size={14} /></a>
                </>
              ) : <span className="faint">нет ссылки</span>}
            </InfoRow>
            <InfoRow label="Устройств"><span className="mono">{sub.devices_used ?? 0} / {sub.devices_limit ?? 1}</span><button className="icon-btn" title="Изменить лимит" onClick={() => setAction('SET_DEVICES')}><Edit2 size={14} /></button></InfoRow>
            <InfoRow label="Особые действия">
              <button className="btn sm" onClick={() => setSpecial('exchange')}><RefreshCw size={14} /> Устройства ⇄ дни</button>
              <button className="btn sm" onClick={() => setSpecial('transfer')}><ArrowUpRight size={14} /> Перенести</button>
            </InfoRow>
            <InfoRow label="Продление пользователем">
              {sub.no_renew ? (
                <>
                  <span className="badge danger">Запрещено</span>
                  <button className="btn sm" disabled={busy} onClick={() => void doAction('SET_NO_RENEW', 0, false)}>Разрешить</button>
                </>
              ) : (
                <>
                  <span className="badge solid">Разрешено</span>
                  <button className="btn sm danger" disabled={busy}
                    onClick={() => void doAction('SET_NO_RENEW', 1, false,
                      'Запретить продление?\n\nПодписка работает до конца срока, но продлить её пользователь не сможет. После окончания она сразу удалится (без 7 дней ожидания).\n\nДокупать устройства, сбрасывать трафик и добавлять подписку в приложение — можно. Сами вы продлить можете, как и раньше.')}>
                    <Ban size={14} /> Запретить
                  </button>
                </>
              )}
            </InfoRow>
            {sub.no_renew && (
              <div className="sub" style={{ marginTop: 6 }}>
                Пользователь не может продлить подписку. После окончания ({fmtDateTime(sub.expiry_date)}) она сразу удалится.
              </div>
            )}
          </>
        )}
      </DCard>

      {detail.subscriptions_history && detail.subscriptions_history.length > 0 && (
        <DCard title="История подписок" icon={Clock}>
          <div className="flex flex-col gap-1">
            {detail.subscriptions_history.map((h) => {
              const expired = h.status === 'Active' && h.expiry_date && new Date(h.expiry_date).getTime() < Date.now();
              const badge = h.status === 'Deleted' ? { cls: 'line', label: 'Удалена' }
                : h.status === 'Banned' ? { cls: 'danger', label: 'Заблокирована' }
                : (h.status === 'Expired' || expired) ? { cls: 'mute', label: 'Истекла' }
                : { cls: 'solid', label: 'Активна' };
              return (
                <div key={h.id} className="inset flex items-center justify-between gap-3" style={{ padding: '9px 12px', flexWrap: 'wrap' }}>
                  <span className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
                    <span className="mono muted">#{h.id}</span>
                    <span>{h.type === 'trial' ? 'Пробная' : 'Платная'}</span>
                    <span className="sub">{h.devices_limit ?? 1} устр.</span>
                    <span className={`badge ${badge.cls}`}>{badge.label}</span>
                  </span>
                  <span className="sub mono" style={{ fontSize: 12 }}>
                    {fmtDateTime(h.created_at)} → {fmtDateTime(h.expiry_date)}
                    {h.deleted_at ? <> · удалена {fmtDateTime(h.deleted_at)}</> : null}
                  </span>
                </div>
              );
            })}
          </div>
        </DCard>
      )}

      <DCard title="Remnawave" icon={Shield}>
        {!rw ? <div className="center" style={{ padding: 20 }}><Spinner size={18} /></div>
          : !rw.configured ? <div className="muted sm">Remnawave не настроена.</div>
          : !rw.found ? <div className="muted sm">Пользователь не найден в Remnawave.</div>
          : (
          <>
            <InfoRow label="Онлайн / последний вход"><span>{rw.online_at ? relTime(rw.online_at) : '—'}</span></InfoRow>
            <InfoRow label="Первое подключение"><span className="mono">{fmtDateTime(rw.first_connected_at)}</span></InfoRow>
            <InfoRow label="Подписка">
              {rw.subscription_url
                ? <button className="btn ghost sm mono" style={{ padding: 0, maxWidth: 230, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}
                    title="Скопировать ссылку на подписку"
                    onClick={async () => { if (await copyToClipboard(rw.subscription_url!)) onToast('Скопировано', 'Ссылка на подписку', 'success'); }}>
                    {rw.subscription_url.replace(/^https?:\/\//, '')}
                  </button>
                : <span className="faint">—</span>}
              <button className="btn sm danger" disabled={busy}
                onClick={() => void doAction('RESET_SUB', null, true,
                  'Сбросить подписку?\n\nRemnawave выдаст новый ключ: старая ссылка и все настроенные на неё приложения перестанут работать. Пользователь получит сообщение в Telegram, что нужно заново добавить подписку.')}>
                <RefreshCw size={14} /> Сбросить
              </button>
            </InfoRow>
            {rw.last_user_agent && <InfoRow label="Клиент"><span className="sub" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rw.last_user_agent}</span></InfoRow>}
            <div className="mt-3">
              <div className="sub mb-2">Устройства ({rw.devices.length}{rw.hwid_device_limit ? ` / ${rw.hwid_device_limit}` : ''})</div>
              {rw.devices.length === 0 ? <div className="muted sm">Нет привязанных устройств</div> : (
                <div className="flex flex-col gap-1">
                  {rw.devices.map((d) => (
                    <div key={d.hwid} className="inset flex items-center justify-between gap-2" style={{ padding: '8px 10px' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 500 }}>{[d.platform, d.device_model].filter(Boolean).join(' · ') || 'Устройство'}</div>
                        <div className="sub" style={{ fontSize: 12 }}>
                          активность: {whenRu(d.updated_at || d.created_at)}{d.created_at ? ` · добавлено ${whenRu(d.created_at)}` : ''}
                        </div>
                        <div className="faint mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280, fontSize: 11 }}>{d.hwid}</div>
                      </div>
                      <button className="icon-btn danger" title="Отвязать" onClick={() => void unlinkDevice(d.hwid)}><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {rw.error && <div className="sub" style={{ marginTop: 8 }}>{rw.error}</div>}
          </>
        )}
      </DCard>

      <DCard title="История платежей" icon={CreditCard}>
        {payments.length === 0 ? <div className="muted sm">Платежей нет.</div> : (
          <div className="tbl-wrap"><div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Дата</th><th>Провайдер</th><th>Сумма</th><th>Назначение</th><th>Статус</th><th></th></tr></thead>
              <tbody>
                {payments.map((pm) => (
                  <tr key={String(pm.id)} style={refundedRowStyle(pm.status)}>
                    <td className="muted mono">{fmtDateTime(pm.created_at)}</td>
                    <td>{pm.provider || '—'}</td>
                    <td className="mono">
                      {pm.stars ? `${pm.stars} ⭐` : `${pm.amount ?? 0} ${pm.currency || ''}`}
                      {pm.referral_applied ? <span className="sub" style={{ marginLeft: 6 }}>+{pm.referral_applied}₽ реф.</span> : null}
                    </td>
                    <td className="sub">{pm.description || pm.purpose || '—'}</td>
                    <td><PaymentStatusBadge status={pm.status} /></td>
                    <td>
                      {pm.refundable ? (
                        <button className="btn sm danger" disabled={busy} onClick={() => void doRefund(pm)}>Возврат</button>
                      ) : pm.refunded_at ? (
                        <span className="sub">возвращён</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></div>
        )}
      </DCard>

      {survey && survey.taken && (
        <DCard title="Опрос" icon={ClipboardList}>
          <InfoRow label="Статус">
            <span className={`badge ${survey.completed ? 'solid' : 'mute'}`}>{survey.completed ? 'пройден' : 'начат, не завершён'}</span>
          </InfoRow>
          {survey.completed_at && <InfoRow label="Пройден"><span className="mono">{fmtDateTime(survey.completed_at)}</span></InfoRow>}
          <div className="mt-3 flex flex-col gap-2">
            {survey.answers.filter((a) => a.answers.length > 0).map((a) => (
              <div key={a.n} className="inset" style={{ padding: '8px 10px' }}>
                <div className="sub" style={{ marginBottom: 2 }}>{a.n}. {a.q}</div>
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{a.answers.join(', ')}</div>
              </div>
            ))}
          </div>
        </DCard>
      )}
    </div>
  );
};
