import React, { useState, useEffect } from 'react';
import {
  CheckCircle, Search, ArrowUpRight, Save, AlertTriangle, RefreshCw,
} from 'lucide-react';
import { Modal, Spinner } from '../../components/ui';
import { apiFetch, parseErr } from '../../lib/api';
import { devWord, fmtDateTime, fmtDays } from '../../lib/format';
import type { ToastType } from '../../lib/types';

export const ExchangeModal: React.FC<{ userId: number; current: number; onClose: () => void; onDone: () => void; onToast: (t: string, m: string, ty?: ToastType) => void }> = ({ userId, current, onClose, onDone, onToast }) => {
  const [devices, setDevices] = useState(Math.max(1, current - 1));
  const [manual, setManual] = useState(false);
  const [days, setDays] = useState('');
  const [notify, setNotify] = useState(true);
  const [calc, setCalc] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const q = manual && days !== '' ? `&days=${encodeURIComponent(days)}` : '';
        const d = await apiFetch(`/panel/users/${userId}/exchange?devices=${devices}${q}`);
        if (alive) { setCalc(d); setErr(''); if (!manual) setDays(String(d.fair_days)); }
      } catch (e) { if (alive) setErr(parseErr(e)); }
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [devices, manual, days, userId]);
  const apply = async () => {
    setBusy(true);
    try {
      await apiFetch(`/panel/users/${userId}/exchange`, { method: 'POST', body: JSON.stringify({ devices, days: manual ? Number(days) : null, notify }) });
      onToast('Готово', `Теперь ${devices} ${devWord(devices)}, ${fmtDays(calc?.new_days ?? 0)}`, 'success'); onDone();
    } catch (e) { setErr(parseErr(e)); } finally { setBusy(false); }
  };
  const same = devices === current && !manual;
  return (
    <Modal onClose={onClose} title="Устройства ⇄ дни" icon={RefreshCw} width={520}
      footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn solid" disabled={busy || same || !calc || !!err} onClick={apply}>{busy ? <Spinner size={15} /> : <Save size={15} />} Применить</button></>}>
      <div className="flex flex-col gap-4">
        <div className="sub" style={{ fontSize: 13 }}>
          Оставшиеся дни пересчитываются по цене тарифа: меньше устройств — больше дней, больше устройств — меньше дней. Деньги пользователя не теряются.
        </div>
        <div>
          <label className="field-label">Сколько устройств оставить</label>
          <div className="flex items-center gap-2">
            <button className="icon-btn" disabled={devices <= 1} onClick={() => setDevices((d) => Math.max(1, d - 1))}>−</button>
            <div className="input" style={{ width: 120, textAlign: 'center', fontWeight: 600 }}>{devices} {devWord(devices)}</div>
            <button className="icon-btn" disabled={devices >= 20} onClick={() => setDevices((d) => Math.min(20, d + 1))}>+</button>
            <span className="sub" style={{ marginLeft: 6, fontSize: 13 }}>сейчас {current}</span>
          </div>
        </div>
        {calc && (
          <div className="inset" style={{ padding: 14 }}>
            <div className="flex justify-between" style={{ fontSize: 14 }}><span className="muted">Было</span><span>{calc.old_devices} {devWord(calc.old_devices)} · {fmtDays(calc.days_left)} · до {fmtDateTime(calc.expires_at).slice(0, 10)}</span></div>
            <div className="flex justify-between" style={{ fontSize: 14, marginTop: 8 }}><span className="muted">Станет</span><span style={{ fontWeight: 600 }}>{calc.new_devices} {devWord(calc.new_devices)} · {fmtDays(calc.new_days)} · до {fmtDateTime(calc.new_expires_at).slice(0, 10)}</span></div>
            <div className="flex justify-between" style={{ fontSize: 13, marginTop: 8 }}><span className="faint">Разница</span>
              <span style={{ color: calc.delta_days > 0 ? '#34d399' : calc.delta_days < 0 ? 'var(--danger)' : undefined }}>{calc.delta_days > 0 ? '+' : ''}{fmtDays(calc.delta_days)}</span></div>
          </div>
        )}
        <label className="flex items-center gap-2 sub" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} /> Задать остаток дней вручную
        </label>
        {manual && <div><label className="field-label">Сколько дней будет после изменения</label><input className="input" type="number" min={0} step={1} value={days} onChange={(e) => setDays(e.target.value)} />
          {calc && <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>по расчёту — {fmtDays(calc.fair_days)}</div>}</div>}
        <label className="flex items-center gap-2 sub" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Сообщить пользователю в боте
        </label>
        {err && <div className="badge danger" style={{ width: '100%', padding: '10px 12px', justifyContent: 'flex-start', whiteSpace: 'normal' }}>{err}</div>}
      </div>
    </Modal>
  );
};

export const TransferModal: React.FC<{ userId: number; onClose: () => void; onDone: (targetId: number) => void; onToast: (t: string, m: string, ty?: ToastType) => void }> = ({ userId, onClose, onDone, onToast }) => {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const [target, setTarget] = useState<any>(null);
  const [plan, setPlan] = useState<any>(null);
  const [notify, setNotify] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (target || q.trim().length < 2) { setFound([]); return; }
    let alive = true;
    const t = setTimeout(async () => {
      try { const d = await apiFetch(`/panel/users?search=${encodeURIComponent(q.trim())}&limit=6`); if (alive) setFound((d?.items || []).filter((u: any) => u.id !== userId)); } catch { /* ignore */ }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q, target, userId]);
  useEffect(() => {
    if (!target) { setPlan(null); return; }
    setErr('');
    apiFetch(`/panel/users/${userId}/transfer?target_id=${target.id}`).then(setPlan).catch((e) => { setPlan(null); setErr(parseErr(e)); });
  }, [target, userId]);
  const label = (u: any) => u.username ? `@${u.username}` : u.telegram_id ? `id${u.telegram_id}` : (u.email || `#${u.id}`);
  const go = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const r = await apiFetch(`/panel/users/${userId}/transfer`, { method: 'POST', body: JSON.stringify({ target_id: target.id, notify }) });
      onToast('Готово', `Подписка перенесена к ${r?.target?.label || label(target)}`, 'success'); onDone(target.id);
    } catch (e) { setErr(parseErr(e)); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose} title="Перенести подписку" icon={ArrowUpRight} width={560}
      footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn solid" disabled={busy || !plan} onClick={go}>{busy ? <Spinner size={15} /> : <ArrowUpRight size={15} />} Перенести</button></>}>
      <div className="flex flex-col gap-4">
        {!target ? (
          <div>
            <label className="field-label">Кому перенести</label>
            <div className="search"><Search className="ico" size={16} /><input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="@username, Telegram ID, почта или ID" /></div>
            {found.length > 0 && (
              <div className="flex flex-col" style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
                {found.map((u) => (
                  <button key={u.id} className="menu-item flex items-center justify-between" onClick={() => setTarget(u)} style={{ padding: '10px 12px', textAlign: 'left' }}>
                    <span style={{ fontWeight: 500 }}>{label(u)}</span>
                    <span className="sub" style={{ fontSize: 12 }}>#{u.id}{u.email && u.username ? ` · ${u.email}` : ''}</span>
                  </button>
                ))}
              </div>
            )}
            {q.trim().length >= 2 && found.length === 0 && <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>Никого не нашлось. Человек должен хотя бы раз зайти в бота или на сайт.</div>}
          </div>
        ) : (
          <div className="inset flex items-center justify-between" style={{ padding: '10px 14px' }}>
            <span>Кому: <b style={{ fontWeight: 600 }}>{label(target)}</b> <span className="faint">#{target.id}</span></span>
            <button className="btn sm" onClick={() => { setTarget(null); setPlan(null); setErr(''); }}>Сменить</button>
          </div>
        )}
        {plan && (
          <div className="inset" style={{ padding: 14, fontSize: 14, lineHeight: 1.55 }}>
            <div className="flex items-center gap-2" style={{ marginBottom: 6, fontWeight: 600 }}>
              {plan.mode === 'move' ? <><CheckCircle size={16} style={{ color: '#34d399' }} /> Перенос целиком, ссылка сохранится</> : <><AlertTriangle size={16} style={{ color: '#fb923c' }} /> Перенос остатка дней, ссылка сменится</>}
            </div>
            <div className="muted">{plan.text}</div>
          </div>
        )}
        {target && (
          <label className="flex items-center gap-2 sub" style={{ fontSize: 13 }}>
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Сообщить обоим в боте
          </label>
        )}
        {err && <div className="badge danger" style={{ width: '100%', padding: '10px 12px', justifyContent: 'flex-start', whiteSpace: 'normal' }}>{err}</div>}
      </div>
    </Modal>
  );
};
