import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CalendarRange, Gavel, Gift, KeyRound, LogOut, Pencil, Plus, Power, RefreshCw, Save, Settings2, Trash2, UserPlus, Wallet } from 'lucide-react';
import { DotsMenu, Modal, PageHead, Segmented, Spinner, Toggle } from '../../components/ui';
import { apiFetch, copyToClipboard, parseApiErr } from '../../lib/api';
import { isOwner, useMe } from '../../lib/access';
import { fmtDateTime } from '../../lib/format';
import type { ToastType } from '../../lib/types';
import {
  addDays, Day, hoursText, Interval, IntervalsEditor, money, monthEnd, monthStart, MonthCalendar, ROLE_RU, ruDate, ShiftBadge, spillFromPrev, StatBox, WEEK,
} from './common';

type Toast = (t: string, m: string, ty: ToastType) => void;
type Staff = {
  id: number; username: string; name: string; role: 'curator' | 'operator'; is_active: boolean; telegram_id?: number;
  last_login_at?: string | null; last_login_ip?: string | null; balance?: number; tickets_in_work: number;
  shift?: { working_today: boolean; on_shift: boolean; intervals: string[][] };
};
type Fine = { id: number; amount: number; reason: string; issued_by: string; issued_name?: string; created_at: string; cancelled: boolean };
type Bonus = { id: number; amount: number; reason: string; issued_name?: string; created_at: string; cancelled: boolean };
type Ledger = {
  balance: number; earned: number; bonused: number; fined: number; paid: number; earned_this_week: number;
  days: Day[]; fines: Fine[]; bonuses: Bonus[]; payouts: { id: number; amount: number; note: string; paid_on: string }[];
};

const genPassword = () => {
  const a = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint32Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (x) => a[x % a.length]).join('');
};

// создание / правка сотрудника (owner)
const StaffEditor: React.FC<{ staff: Staff | null; onClose: () => void; onSaved: (s: Staff, pw?: string) => void; onToast: Toast }> = ({ staff, onClose, onSaved, onToast }) => {
  const isNew = !staff;
  const [username, setUsername] = useState(staff?.username || '');
  const [name, setName] = useState(staff?.name || '');
  const [tg, setTg] = useState(staff?.telegram_id ? String(staff.telegram_id) : '');
  const [role, setRole] = useState<'curator' | 'operator'>(staff?.role || 'operator');
  const [password, setPassword] = useState(isNew ? genPassword() : '');
  const [active, setActive] = useState(staff ? staff.is_active : true);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body: any = { name, telegram_id: tg.trim(), role };
      if (password) body.password = password;
      const r: Staff = isNew
        ? await apiFetch('/panel/staff', { method: 'POST', body: JSON.stringify({ ...body, username: username.trim() }) })
        : await apiFetch(`/panel/staff/${staff!.id}`, { method: 'PUT', body: JSON.stringify({ ...body, is_active: active }) });
      onSaved(r, password || undefined);
    } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось сохранить'), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose} title={isNew ? 'Новый сотрудник поддержки' : `Сотрудник ${staff!.username}`} icon={isNew ? UserPlus : Pencil} width={560}
      footer={<><button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn solid" disabled={busy || (isNew && (!username.trim() || !password)) || !tg.trim()} onClick={save}>
          {busy ? <Spinner size={15} /> : <Save size={15} />} {isNew ? 'Создать' : 'Сохранить'}</button></>}>
      <div className="flex flex-col gap-4">
        <div>
          <label className="field-label">Роль</label>
          <Segmented value={role} onChange={setRole} options={[{ value: 'operator', label: 'Оператор' }, { value: 'curator', label: 'Куратор' }]} />
          <div className="faint" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
            {role === 'operator'
              ? 'Берёт обращения из пула, закрывает через вопрос пользователю, может вернуть в пул или передать админу. Видит всех пользователей, менять может только тех, чьё обращение у него в работе (без денег, объединения и удаления).'
              : 'Админ поддержки: видит все обращения (и чужие, и закрытые), забирает, пишет в чужих, закрывает сразу, штрафует операторов. Видит и меняет всех пользователей.'}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div><label className="field-label">Логин</label>
            <input className="input" value={username} disabled={!isNew} onChange={(e) => setUsername(e.target.value.toLowerCase())} placeholder="anna" autoComplete="off" /></div>
          <div><label className="field-label">Имя (видно в панели)</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Анна" maxLength={40} /></div>
          <div><label className="field-label">{isNew ? 'Пароль' : 'Новый пароль'}</label>
            <div className="flex gap-2">
              <input className="input mono" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={isNew ? '' : 'не менять'} autoComplete="new-password" />
              <button className="icon-btn" title="Сгенерировать" onClick={() => setPassword(genPassword())} style={{ flex: 'none', width: 40, height: 40 }}><RefreshCw size={15} /></button>
            </div>
            <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>Не короче 10 символов{!isNew ? '. Смена завершит все сеансы' : ''}</div></div>
          <div><label className="field-label">Telegram ID (коды входа)</label>
            <input className="input mono" value={tg} onChange={(e) => setTg(e.target.value.replace(/[^\d]/g, ''))} placeholder="123456789" inputMode="numeric" />
            <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>Сотрудник должен запустить бота (/start)</div></div>
        </div>
        {!isNew && (
          <div className="flex items-center justify-between gap-3 inset" style={{ padding: 12 }}>
            <div><div style={{ fontWeight: 500 }}>Доступ включён</div><div className="sub" style={{ fontSize: 12 }}>Выключите — сеансы завершатся, обращения вернутся в пул</div></div>
            <Toggle on={active} onChange={() => setActive(!active)} />
          </div>
        )}
      </div>
    </Modal>
  );
};

// день графика
const DayModal: React.FC<{ staffId: number; day: string; cur?: Day; spill?: Interval[]; onClose: () => void; onSaved: () => void; onToast: Toast }> = ({ staffId, day, cur, spill, onClose, onSaved, onToast }) => {
  const [working, setWorking] = useState(!!cur);
  const [iv, setIv] = useState<Interval[]>(cur?.intervals?.length ? cur.intervals : [['10:00', '19:00']]);
  const [pay, setPay] = useState(String(cur?.pay ?? ''));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await apiFetch(`/panel/staff/${staffId}/schedule/${day}`, { method: 'PUT', body: JSON.stringify(working ? { intervals: iv, pay: Number(pay || 0) } : { intervals: null }) });
      onSaved();
    } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось сохранить'), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose} title={ruDate(day)} icon={CalendarRange} width={480}
      footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn solid" disabled={busy} onClick={save}>{busy ? <Spinner size={15} /> : <Save size={15} />} Сохранить</button></>}>
      <div className="flex flex-col gap-4">
        {!!spill?.length && (
          <div className="sub" style={{ fontSize: 13 }}>
            До {spill[0][1]} продолжается смена со вчера (оплата вчерашнего дня). Новую смену начинайте не раньше {spill[0][1]}.
          </div>
        )}
        <div className="flex items-center justify-between"><span style={{ fontWeight: 500 }}>Рабочий день</span><Toggle on={working} onChange={() => setWorking(!working)} /></div>
        {working && (<>
          <IntervalsEditor value={iv} onChange={setIv} />
          <div><label className="field-label">Оплата за этот день, ₽</label>
            <input className="input" type="number" min={0} value={pay} onChange={(e) => setPay(e.target.value)} placeholder="1000" /></div>
        </>)}
      </div>
    </Modal>
  );
};

// заполнить период
const BulkModal: React.FC<{ staffId: number; today: string; onClose: () => void; onSaved: (n: number) => void; onToast: Toast }> = ({ staffId, today, onClose, onSaved, onToast }) => {
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDays(today, 364));
  const [wd, setWd] = useState<number[]>([0, 1, 2, 3, 4]);
  const [iv, setIv] = useState<Interval[]>([['10:00', '14:00'], ['15:00', '19:00']]);
  const [pay, setPay] = useState('1000');
  const [overwrite, setOverwrite] = useState(true);
  const [clearOther, setClearOther] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await apiFetch(`/panel/staff/${staffId}/schedule/bulk`, { method: 'POST', body: JSON.stringify({
        date_from: from, date_to: to, weekdays: wd, intervals: iv, pay: Number(pay || 0), overwrite, clear_other: clearOther }) });
      onSaved(r.days);
    } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось заполнить'), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose} title="Заполнить график" icon={CalendarRange} width={560}
      footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn solid" disabled={busy || !wd.length} onClick={save}>{busy ? <Spinner size={15} /> : <Save size={15} />} Заполнить</button></>}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <div><label className="field-label">С</label><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><label className="field-label">По (до года вперёд)</label><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
        <div>
          <label className="field-label">Рабочие дни недели</label>
          <div className="flex gap-1" style={{ flexWrap: 'wrap' }}>
            {WEEK.map((w, i) => (
              <button key={w} className={`btn sm ${wd.includes(i) ? 'solid' : ''}`} onClick={() => setWd(wd.includes(i) ? wd.filter((x) => x !== i) : [...wd, i].sort())}>{w}</button>
            ))}
            <button className="btn sm" onClick={() => setWd([0, 1, 2, 3, 4])}>Пн–Пт</button>
            <button className="btn sm" onClick={() => setWd([0, 1, 2, 3, 4, 5, 6])}>Каждый день</button>
          </div>
        </div>
        <div><label className="field-label">Часы работы (по Москве)</label><IntervalsEditor value={iv} onChange={setIv} /></div>
        <div><label className="field-label">Оплата за день, ₽</label><input className="input" type="number" min={0} value={pay} onChange={(e) => setPay(e.target.value)} /></div>
        <div className="flex items-center justify-between gap-3"><span className="sub" style={{ fontSize: 13 }}>Перезаписать уже заданные дни</span><Toggle on={overwrite} onChange={() => setOverwrite(!overwrite)} /></div>
        <div className="flex items-center justify-between gap-3"><span className="sub" style={{ fontSize: 13 }}>Остальные дни периода сделать выходными</span><Toggle on={clearOther} onChange={() => setClearOther(!clearOther)} /></div>
      </div>
    </Modal>
  );
};

// штрафы (owner/curator) и премии (owner)
const FineModal: React.FC<{ staff: Staff; bonus?: boolean; onClose: () => void; onSaved: () => void; onToast: Toast }> = ({ staff, bonus, onClose, onSaved, onToast }) => {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const Icon = bonus ? Gift : Gavel;
  const save = async () => {
    if (busy) return;
    setBusy(true);
    try { await apiFetch(`/panel/staff/${staff.id}/${bonus ? 'bonuses' : 'fines'}`, { method: 'POST', body: JSON.stringify({ amount: Number(amount), reason }) }); onSaved(); }
    catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось'), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose} title={`${bonus ? 'Премия' : 'Штраф'}: ${staff.name || staff.username}`} icon={Icon} width={440}
      footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn solid" disabled={busy || !Number(amount) || reason.trim().length < 3} onClick={save}>{busy ? <Spinner size={15} /> : <Icon size={15} />} {bonus ? 'Начислить премию' : 'Оштрафовать'}</button></>}>
      <div className="flex flex-col gap-3">
        <div><label className="field-label">Сумма, ₽</label><input className="input" type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={bonus ? '1000' : '300'} /></div>
        <div><label className="field-label">{bonus ? 'За что' : 'Причина'}</label><textarea className="input" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={bonus ? 'Например: лучшие оценки за неделю' : 'Например: ответ через 2 часа'} style={{ resize: 'vertical' }} /></div>
        <div className="faint" style={{ fontSize: 12 }}>Сотруднику придёт сообщение в Telegram, сумма {bonus ? 'прибавится к зарплате' : 'вычтется из зарплаты'}.</div>
      </div>
    </Modal>
  );
};

const BonusesList: React.FC<{ bonuses: Bonus[]; onCancel?: (b: Bonus) => void }> = ({ bonuses, onCancel }) => (
  bonuses.length === 0 ? <div className="sub" style={{ fontSize: 13 }}>Премий нет</div> : (
    <div className="flex flex-col">
      {bonuses.map((b) => (
        <div key={b.id} className="flex items-start justify-between gap-3" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', opacity: b.cancelled ? 0.5 : 1 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, textDecoration: b.cancelled ? 'line-through' : undefined }}>{b.reason}</div>
            <div className="faint" style={{ fontSize: 12 }}>{fmtDateTime(b.created_at).slice(0, 16)}{b.cancelled ? ' · отменена' : ''}</div>
          </div>
          <div className="flex items-center gap-2" style={{ flex: 'none' }}>
            <span style={{ color: '#34d399', fontWeight: 600 }}>+{money(b.amount)}</span>
            {!b.cancelled && onCancel && <button className="icon-btn" title="Отменить премию" onClick={() => onCancel(b)}><Trash2 size={14} /></button>}
          </div>
        </div>
      ))}
    </div>
  )
);

const FinesList: React.FC<{ fines: Fine[]; canCancel: (f: Fine) => boolean; onCancel: (f: Fine) => void }> = ({ fines, canCancel, onCancel }) => (
  fines.length === 0 ? <div className="sub" style={{ fontSize: 13 }}>Штрафов нет</div> : (
    <div className="flex flex-col">
      {fines.map((f) => (
        <div key={f.id} className="flex items-start justify-between gap-3" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', opacity: f.cancelled ? 0.5 : 1 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, textDecoration: f.cancelled ? 'line-through' : undefined }}>{f.reason}</div>
            <div className="faint" style={{ fontSize: 12 }}>{fmtDateTime(f.created_at).slice(0, 16)} · {f.issued_name || f.issued_by}{f.cancelled ? ' · отменён' : ''}</div>
          </div>
          <div className="flex items-center gap-2" style={{ flex: 'none' }}>
            <span style={{ color: 'var(--danger)', fontWeight: 600 }}>−{money(f.amount)}</span>
            {!f.cancelled && canCancel(f) && <button className="icon-btn" title="Отменить штраф" onClick={() => onCancel(f)}><Trash2 size={14} /></button>}
          </div>
        </div>
      ))}
    </div>
  )
);

const StaffDetail: React.FC<{ staff: Staff; today: string; owner: boolean; myActor: string; onBack: () => void; onChanged: () => void; onToast: Toast }> =
  ({ staff, today, owner, myActor, onBack, onChanged, onToast }) => {
    const [tab, setTab] = useState<'schedule' | 'money' | 'profile'>('schedule');
    const [month, setMonth] = useState(monthStart(today));
    const [days, setDays] = useState<Record<string, Day>>({});
    const [ledger, setLedger] = useState<Ledger | null>(null);
    const [fines, setFines] = useState<Fine[] | null>(null);
    const [dayEdit, setDayEdit] = useState<string | null>(null);
    const [bulk, setBulk] = useState(false);
    const [fineOpen, setFineOpen] = useState(false);
    const [bonusOpen, setBonusOpen] = useState(false);
    const [payOpen, setPayOpen] = useState(false);
    const [editOpen, setEditOpen] = useState(false);
    const [payAmount, setPayAmount] = useState('');
    const [payNote, setPayNote] = useState('');

    const loadDays = useCallback(() => {
      apiFetch(`/panel/staff/${staff.id}/schedule?from=${addDays(monthStart(month), -1)}&to=${monthEnd(month)}`)
        .then((r) => setDays(Object.fromEntries((r.days as Day[]).map((d) => [d.day, d])))).catch(() => setDays({}));
    }, [staff.id, month]);
    const loadMoney = useCallback(() => {
      if (owner) apiFetch(`/panel/staff/${staff.id}/ledger`).then(setLedger).catch(() => {});
      else apiFetch(`/panel/staff/${staff.id}/fines`).then((r) => setFines(r.fines)).catch(() => setFines([]));
    }, [staff.id, owner]);
    useEffect(() => { loadDays(); }, [loadDays]);
    useEffect(() => { loadMoney(); }, [loadMoney]);

    const cancelFine = async (f: Fine) => {
      if (!window.confirm(`Отменить штраф ${money(f.amount)}?`)) return;
      try { await apiFetch(`/panel/staff/fines/${f.id}`, { method: 'DELETE' }); loadMoney(); onChanged(); } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось'), 'error'); }
    };
    const cancelBonus = async (b: Bonus) => {
      if (!window.confirm(`Отменить премию ${money(b.amount)}?`)) return;
      try { await apiFetch(`/panel/staff/bonuses/${b.id}`, { method: 'DELETE' }); loadMoney(); onChanged(); } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось'), 'error'); }
    };
    const [payBusy, setPayBusy] = useState(false);
    const payout = async () => {
      if (payBusy) return;
      setPayBusy(true);
      try {
        await apiFetch(`/panel/staff/${staff.id}/payouts`, { method: 'POST', body: JSON.stringify({ amount: Number(payAmount), note: payNote }) });
        setPayOpen(false); setPayNote(''); loadMoney(); onChanged(); onToast('Выплата', `${money(Number(payAmount))} отмечено как выплаченное`, 'success');
      } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось'), 'error'); } finally { setPayBusy(false); }
    };
    const delPayout = async (id: number) => {
      if (!window.confirm('Удалить запись о выплате?')) return;
      try { await apiFetch(`/panel/staff/payouts/${id}`, { method: 'DELETE' }); loadMoney(); onChanged(); } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось'), 'error'); }
    };
    const logoutAll = async () => {
      try { await apiFetch(`/panel/staff/${staff.id}/logout`, { method: 'POST' }); onToast('Готово', 'Все сеансы сотрудника завершены', 'success'); } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось'), 'error'); }
    };
    const remove = async () => {
      if (!window.confirm(`Удалить ${staff.name || staff.username}? Доступ пропадёт сразу, его обращения вернутся в пул, история денег удалится.`)) return;
      try { await apiFetch(`/panel/staff/${staff.id}`, { method: 'DELETE' }); onToast('Удалено', staff.username, 'success'); onBack(); onChanged(); } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось'), 'error'); }
    };

    const tabs = owner ? [{ value: 'schedule', label: 'График' }, { value: 'money', label: 'Зарплата, премии и штрафы' }, { value: 'profile', label: 'Профиль' }]
      : [{ value: 'schedule', label: 'График' }, { value: 'money', label: 'Штрафы' }];
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3" style={{ flexWrap: 'wrap' }}>
          <button className="icon-btn" onClick={onBack}><ArrowLeft size={16} /></button>
          <div style={{ minWidth: 0 }}>
            <div className="h-page" style={{ fontSize: 22 }}>{staff.name || staff.username}</div>
            <div className="sub" style={{ fontSize: 13 }}>{ROLE_RU[staff.role]} · <span className="mono">{staff.username}</span></div>
          </div>
          <div className="flex-1" />
          <ShiftBadge shift={staff.shift} />
          {owner && <button className="btn" onClick={() => setBonusOpen(true)}><Gift size={15} /> Премия</button>}
          {(owner || staff.role === 'operator') && <button className="btn" onClick={() => setFineOpen(true)}><Gavel size={15} /> Штраф</button>}
        </div>
        <Segmented value={tab} onChange={(v) => setTab(v as any)} options={tabs as any} />

        {tab === 'schedule' && (
          <div className="card" style={{ padding: 16 }}>
            {owner && (
              <div className="flex gap-2" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
                <button className="btn solid" onClick={() => setBulk(true)}><CalendarRange size={15} /> Заполнить период</button>
                <span className="sub" style={{ fontSize: 12, alignSelf: 'center' }}>Нажмите на день, чтобы поменять часы, перерывы или оплату</span>
              </div>
            )}
            <MonthCalendar month={month} today={today} days={days} showPay={owner} onMonth={setMonth} onDay={owner ? setDayEdit : undefined} />
          </div>
        )}

        {tab === 'money' && owner && (ledger ? (<>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatBox label="К выплате" value={money(ledger.balance)} hint="начислено + премии − штрафы − выплаты" />
            <StatBox label="На этой неделе" value={money(ledger.earned_this_week)} />
            <StatBox label="Премии / штрафы" value={`+${money(ledger.bonused || 0)} / −${money(ledger.fined)}`} />
            <StatBox label="Выплачено, всего" value={money(ledger.paid)} />
          </div>
          <div className="flex gap-2"><button className="btn solid" onClick={() => { setPayAmount(String(Math.max(0, ledger.balance))); setPayOpen(true); }}><Wallet size={15} /> Отметить выплату</button></div>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="card" style={{ padding: 16 }}><div className="h-sec" style={{ marginBottom: 8 }}>Начислено по дням</div>
              {ledger.days.length === 0 ? <div className="sub" style={{ fontSize: 13 }}>Пока нет отработанных дней</div> : ledger.days.slice(0, 40).map((d) => (
                <div key={d.day} className="flex justify-between gap-3" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                  <span><span style={{ fontWeight: 500 }}>{ruDate(d.day)}</span> <span className="faint">{hoursText(d.intervals)}</span></span><span>+{money(d.pay || 0)}</span>
                </div>))}
            </div>
            <div className="flex flex-col gap-4">
              <div className="card" style={{ padding: 16 }}><div className="h-sec" style={{ marginBottom: 8 }}>Премии</div>
                <BonusesList bonuses={ledger.bonuses || []} onCancel={cancelBonus} />
              </div>
              <div className="card" style={{ padding: 16 }}><div className="h-sec" style={{ marginBottom: 8 }}>Штрафы</div>
                <FinesList fines={ledger.fines} canCancel={() => true} onCancel={cancelFine} />
              </div>
            </div>
            <div className="card" style={{ padding: 16 }}><div className="h-sec" style={{ marginBottom: 8 }}>Выплаты</div>
              {ledger.payouts.length === 0 ? <div className="sub" style={{ fontSize: 13 }}>Выплат ещё не было</div> : ledger.payouts.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-3" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                  <span>{ruDate(p.paid_on)}{p.note ? <span className="faint"> · {p.note}</span> : null}</span>
                  <span className="flex items-center gap-2">{money(p.amount)}<button className="icon-btn" title="Удалить" onClick={() => void delPayout(p.id)}><Trash2 size={13} /></button></span>
                </div>))}
            </div>
          </div>
        </>) : <Spinner />)}

        {tab === 'money' && !owner && (
          <div className="card" style={{ padding: 16 }}>
            {fines == null ? <Spinner /> : <FinesList fines={fines} canCancel={(f) => f.issued_by === myActor} onCancel={cancelFine} />}
          </div>
        )}

        {tab === 'profile' && owner && (
          <div className="card" style={{ padding: 16 }}>
            <div className="flex flex-col gap-2" style={{ fontSize: 14 }}>
              <div>Telegram ID: <span className="mono">{staff.telegram_id}</span></div>
              <div>Статус: {staff.is_active ? 'доступ включён' : <span style={{ color: 'var(--danger)' }}>отключён</span>}</div>
              <div className="sub">{staff.last_login_at ? `Последний вход: ${fmtDateTime(staff.last_login_at).slice(0, 16)}${staff.last_login_ip ? ` · ${staff.last_login_ip}` : ''}` : 'Ещё не входил'}</div>
            </div>
            <div className="flex gap-2" style={{ marginTop: 14, flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => setEditOpen(true)}><Pencil size={15} /> Изменить</button>
              <button className="btn" onClick={logoutAll}><LogOut size={15} /> Завершить сеансы</button>
              <button className="btn danger" onClick={remove}><Trash2 size={15} /> Удалить</button>
            </div>
          </div>
        )}

        {dayEdit && <DayModal staffId={staff.id} day={dayEdit} cur={days[dayEdit]} spill={spillFromPrev(days[addDays(dayEdit, -1)])} onToast={onToast} onClose={() => setDayEdit(null)} onSaved={() => { setDayEdit(null); loadDays(); loadMoney(); onChanged(); }} />}
        {bulk && <BulkModal staffId={staff.id} today={today} onToast={onToast} onClose={() => setBulk(false)} onSaved={(n) => { setBulk(false); loadDays(); onChanged(); onToast('График', `Заполнено рабочих дней: ${n}`, 'success'); }} />}
        {fineOpen && <FineModal staff={staff} onToast={onToast} onClose={() => setFineOpen(false)} onSaved={() => { setFineOpen(false); loadMoney(); onChanged(); onToast('Штраф', 'Штраф выдан', 'success'); }} />}
        {bonusOpen && <FineModal bonus staff={staff} onToast={onToast} onClose={() => setBonusOpen(false)} onSaved={() => { setBonusOpen(false); loadMoney(); onChanged(); onToast('Премия', 'Премия начислена', 'success'); }} />}
        {editOpen && <StaffEditor staff={staff} onToast={onToast} onClose={() => setEditOpen(false)} onSaved={() => { setEditOpen(false); onChanged(); onToast('Сохранено', staff.username, 'success'); }} />}
        {payOpen && (
          <Modal onClose={() => setPayOpen(false)} title="Выплата зарплаты" icon={Wallet} width={420}
            footer={<><button className="btn" onClick={() => setPayOpen(false)}>Отмена</button><button className="btn solid" disabled={!Number(payAmount) || payBusy} onClick={payout}>{payBusy ? <Spinner size={15} /> : <Save size={15} />} Сохранить</button></>}>
            <div className="flex flex-col gap-3">
              <div><label className="field-label">Сколько выплатили, ₽</label><input className="input" type="number" min={1} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} /></div>
              <div><label className="field-label">Комментарий</label><input className="input" value={payNote} maxLength={200} onChange={(e) => setPayNote(e.target.value)} placeholder="За неделю 22–28 сентября" /></div>
            </div>
          </Modal>
        )}
      </div>
    );
  };

// журнал (owner)
const ACTION_RU: Record<string, string> = { login_ok: 'Вход в панель', login_fail: 'Неверный пароль', '2fa_fail': 'Неверный код входа', login_disabled: 'Попытка входа (доступ отключён)' };
const Journal: React.FC<{ staff: Staff[] }> = ({ staff }) => {
  const [actor, setActor] = useState('');
  const [items, setItems] = useState<any[] | null>(null);
  useEffect(() => {
    setItems(null);
    apiFetch(`/panel/staff/audit?limit=300${actor ? `&actor=${encodeURIComponent(actor)}` : ''}`).then((r) => setItems(r.items || [])).catch(() => setItems([]));
  }, [actor]);
  const names: Record<string, string> = { owner: 'Администратор' };
  staff.forEach((s) => { names[`staff:${s.id}`] = s.name || s.username; });
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
        <select className="input" style={{ maxWidth: 280 }} value={actor} onChange={(e) => setActor(e.target.value)}>
          <option value="">Все</option><option value="owner">Администратор</option>
          {staff.map((s) => <option key={s.id} value={`staff:${s.id}`}>{s.name || s.username}</option>)}
        </select>
      </div>
      {items == null ? <div style={{ padding: 30, display: 'flex', justifyContent: 'center' }}><Spinner /></div> : items.length === 0 ? <div className="sub" style={{ padding: 20 }}>Записей нет</div> : (
        <div style={{ overflowX: 'auto' }}><table className="tbl">
          <thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Итог</th><th>IP</th></tr></thead>
          <tbody>{items.map((a) => (
            <tr key={a.id}><td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.ts)}</td><td>{names[a.actor] || a.actor_name || a.actor}</td>
              <td className="mono" style={{ fontSize: 12 }}>{ACTION_RU[a.action] || String(a.action).replace('/api/panel', '')}</td>
              <td style={{ color: a.status >= 400 ? 'var(--danger)' : undefined }}>{a.status >= 400 ? `ошибка ${a.status}` : 'ок'}</td>
              <td className="mono" style={{ fontSize: 12 }}>{a.ip}</td></tr>))}</tbody>
        </table></div>
      )}
    </div>
  );
};

export const StaffPage: React.FC<{ onToast: Toast }> = ({ onToast }) => {
  const me = useMe();
  const owner = isOwner(me);
  const [data, setData] = useState<{ staff: Staff[]; today: string; bot_ready: boolean } | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [view, setView] = useState<'staff' | 'journal'>('staff');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null);
  const [fineFor, setFineFor] = useState<Staff | null>(null);
  const [bonusFor, setBonusFor] = useState<Staff | null>(null);
  const [editing, setEditing] = useState<Staff | null>(null);
  const staffAction = async (s: Staff, what: 'logout' | 'disable' | 'enable' | 'delete') => {
    const name = s.name || s.username;
    if (what === 'delete' && !window.confirm(`Удалить ${name}? Доступ пропадёт сразу, обращения вернутся в пул, история зарплаты удалится. Чтобы сохранить историю — лучше отключите доступ.`)) return;
    if (what === 'disable' && !window.confirm(`Отключить доступ ${name}? Сеансы завершатся, обращения вернутся в пул, будущие смены удалятся.`)) return;
    try {
      if (what === 'logout') await apiFetch(`/panel/staff/${s.id}/logout`, { method: 'POST' });
      if (what === 'delete') await apiFetch(`/panel/staff/${s.id}`, { method: 'DELETE' });
      if (what === 'disable' || what === 'enable') await apiFetch(`/panel/staff/${s.id}`, { method: 'PUT', body: JSON.stringify({ is_active: what === 'enable' }) });
      onToast('Готово', { logout: 'Сеансы завершены', delete: 'Сотрудник удалён', disable: 'Доступ отключён', enable: 'Доступ включён' }[what], 'success');
      load();
    } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось'), 'error'); }
  };
  const load = useCallback(() => apiFetch('/panel/staff').then(setData).catch((e) => onToast('Ошибка', parseApiErr(e, 'Не удалось загрузить'), 'error')), [onToast]);
  useEffect(() => { load(); }, []);
  if (!data) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  const open = data.staff.find((s) => s.id === openId);
  const myActor = me?.kind === 'staff' ? `staff:${me.staff_id}` : 'owner';
  if (open) return <StaffDetail staff={open} today={data.today} owner={owner} myActor={myActor} onBack={() => setOpenId(null)} onChanged={load} onToast={onToast} />;

  const groups: ['curator' | 'operator', string][] = [['curator', 'Кураторы'], ['operator', 'Операторы']];
  return (
    <div className="flex flex-col gap-5">
      <PageHead title="Сотрудники" sub={owner ? 'Кураторы и операторы поддержки: график, зарплата, премии, штрафы' : 'Операторы поддержки: график и штрафы'}>
        {owner && (
          <div className="flex gap-2 items-center">
            <Segmented value={view} onChange={setView} options={[{ value: 'staff', label: 'Сотрудники' }, { value: 'journal', label: 'Журнал' }]} />
            {view === 'staff' && <button className="btn solid" onClick={() => setCreating(true)}><Plus size={15} /> Добавить</button>}
          </div>
        )}
      </PageHead>
      {owner && !data.bot_ready && <div className="badge danger" style={{ whiteSpace: 'normal' }}>Бот не настроен — коды входа сотрудникам отправлять некуда.</div>}
      {view === 'journal' && owner ? <Journal staff={data.staff} /> : data.staff.length === 0 ? (
        <div className="card flex flex-col items-center sub" style={{ padding: 40, gap: 10, textAlign: 'center' }}>
          <UserPlus size={30} className="faint" /><div>Сотрудников пока нет</div>
          {owner && <div style={{ fontSize: 13, maxWidth: 440 }}>Добавьте куратора или оператора: логин, пароль и Telegram ID для кода входа.</div>}
        </div>
      ) : (
        <div className="tbl-wrap"><div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>Сотрудник</th><th>Роль</th><th>Сегодня</th><th>В работе</th>{owner && <th>К выплате</th>}{owner && <th>Последний вход</th>}<th></th></tr></thead>
            <tbody>
              {groups.flatMap(([role]) => data.staff.filter((s) => s.role === role)).map((s) => (
                <tr key={s.id} className="click" style={{ opacity: s.is_active ? 1 : 0.55 }} onClick={() => setOpenId(s.id)}>
                  <td><div style={{ fontWeight: 600 }}>{s.name || s.username}</div><div className="faint mono" style={{ fontSize: 12 }}>{s.username}</div></td>
                  <td>{ROLE_RU[s.role]}{!s.is_active && <span className="badge danger" style={{ marginLeft: 6 }}>отключён</span>}</td>
                  <td><ShiftBadge shift={s.shift} /></td>
                  <td className="mono">{s.tickets_in_work}</td>
                  {owner && <td className="mono" style={{ fontWeight: 600 }}>{money(s.balance || 0)}</td>}
                  {owner && <td className="sub" style={{ fontSize: 12 }}>{s.last_login_at ? fmtDateTime(s.last_login_at).slice(0, 16) : 'не входил'}</td>}
                  <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                    <DotsMenu items={[
                      { label: owner ? 'Управлять (график, зарплата)' : 'Открыть (график, штрафы)', icon: Settings2, onClick: () => setOpenId(s.id) },
                      owner && { label: 'Изменить данные и роль', icon: Pencil, onClick: () => setEditing(s) },
                      owner && { label: 'Премия', icon: Gift, onClick: () => setBonusFor(s) },
                      (owner || s.role === 'operator') && { label: 'Штраф', icon: Gavel, onClick: () => setFineFor(s) },
                      owner && { label: 'Завершить все сеансы', icon: LogOut, onClick: () => void staffAction(s, 'logout') },
                      owner && { label: s.is_active ? 'Отключить доступ' : 'Включить доступ', icon: Power, onClick: () => void staffAction(s, s.is_active ? 'disable' : 'enable') },
                      owner && { label: 'Удалить', icon: Trash2, danger: true, onClick: () => void staffAction(s, 'delete') },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>
      )}
      {editing && <StaffEditor staff={editing} onToast={onToast} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); onToast('Сохранено', editing.username, 'success'); }} />}
      {creating && <StaffEditor staff={null} onToast={onToast} onClose={() => setCreating(false)} onSaved={(s, pw) => { setCreating(false); load(); if (pw) setCreated({ username: s.username, password: pw }); }} />}
      {fineFor && <FineModal staff={fineFor} onToast={onToast} onClose={() => setFineFor(null)} onSaved={() => { setFineFor(null); load(); onToast('Штраф', 'Штраф выдан', 'success'); }} />}
      {bonusFor && <FineModal bonus staff={bonusFor} onToast={onToast} onClose={() => setBonusFor(null)} onSaved={() => { setBonusFor(null); load(); onToast('Премия', 'Премия начислена', 'success'); }} />}
      {created && (
        <Modal onClose={() => setCreated(null)} title="Сотрудник создан" icon={KeyRound} width={440} footer={<button className="btn solid" onClick={() => setCreated(null)}>Готово</button>}>
          <div className="flex flex-col gap-3">
            <div className="sub" style={{ fontSize: 13 }}>Передайте данные сотруднику. Пароль больше нигде не показывается.</div>
            <div className="inset" style={{ padding: 12 }}>
              <div className="sub">Логин: <code className="mono" style={{ color: 'var(--text)', userSelect: 'all' }}>{created.username}</code></div>
              <div className="sub">Пароль: <code className="mono" style={{ color: 'var(--text)', userSelect: 'all' }}>{created.password}</code></div>
            </div>
            <button className="btn" onClick={async () => { const ok = await copyToClipboard(`Логин: ${created.username}\nПароль: ${created.password}`); onToast(ok ? 'Скопировано' : 'Ошибка', ok ? 'Логин и пароль в буфере обмена' : 'Не удалось', ok ? 'success' : 'error'); }}>Скопировать</button>
          </div>
        </Modal>
      )}
    </div>
  );
};
