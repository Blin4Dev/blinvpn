import React, { useState } from 'react';
import {
  Settings, CreditCard, Copy, Save, Server, Play, KeyRound,
} from 'lucide-react';
import { Modal, Spinner } from '../../components/ui';
import { apiFetch, copyToClipboard, parseApiErr } from '../../lib/api';
import type { ToastType } from '../../lib/types';
import { toLocalInput } from './shared';
import type { MonDetail, MonNodeBrief } from './shared';

export const InstallSteps: React.FC<{ secret: string; port: number; onToast: (t: string, m: string, ty: ToastType) => void }> = ({ secret, port, onToast }) => {
  const cmd = `curl -fsSL ${window.location.origin}/node.sh -o node.sh && sudo bash node.sh`;
  const copy = async (v: string, what: string) => { if (await copyToClipboard(v)) onToast('Скопировано', what, 'success'); };
  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="field-label">Секретный ключ ноды</label>
        <div className="flex gap-2">
          <input className="input" readOnly value={secret} onFocus={(e) => e.currentTarget.select()} />
          <button className="icon-btn" title="Скопировать" onClick={() => copy(secret, 'Секретный ключ')}><Copy size={15} /></button>
        </div>
        <div className="sub" style={{ fontSize: 12, marginTop: 6 }}>Ключ показывается один раз — в базе он хранится зашифрованным. Если потеряете, перевыпустите его в настройках ноды.</div>
      </div>
      <div>
        <label className="field-label">1. На сервере выполните (от root)</label>
        <div className="flex gap-2">
          <input className="input" readOnly value={cmd} onFocus={(e) => e.currentTarget.select()} />
          <button className="icon-btn" title="Скопировать" onClick={() => copy(cmd, 'Команда установки')}><Copy size={15} /></button>
        </div>
      </div>
      <div className="sub" style={{ fontSize: 13, lineHeight: 1.6 }}>
        2. Установщик спросит <b>секретный ключ</b> — вставьте ключ выше, и <b>порт</b> — оставьте <span style={{ fontVariantNumeric: 'tabular-nums' }}>{port}</span>.<br />
        3. Порт <span style={{ fontVariantNumeric: 'tabular-nums' }}>{port}/tcp</span> должен быть открыт для сервера панели.<br />
        4. Вернитесь сюда и нажмите «Запустить».
      </div>
    </div>
  );
};

export const MonAddModal: React.FC<{ onClose: () => void; onToast: (t: string, m: string, ty: ToastType) => void; onOpen: (id: number) => void }> = ({ onClose, onToast, onOpen }) => {
  const [name, setName] = useState(''); const [ip, setIp] = useState(''); const [port, setPort] = useState('5055');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [created, setCreated] = useState<{ node: MonNodeBrief; secret: string } | null>(null);
  const create = async () => {
    setBusy(true); setErr('');
    try { setCreated(await apiFetch('/panel/monitoring/nodes', { method: 'POST', body: JSON.stringify({ name, ip, port: Number(port) || 5055 }) })); }
    catch (e) { setErr(parseApiErr(e, 'Не удалось добавить ноду')); } finally { setBusy(false); }
  };
  const start = async () => {
    if (!created) return;
    setBusy(true); setErr('');
    try {
      await apiFetch(`/panel/monitoring/nodes/${created.node.id}/start`, { method: 'POST' });
      onToast('Готово', 'Агент на связи, мониторинг запущен', 'success'); onOpen(created.node.id);
    } catch (e) { setErr(parseApiErr(e, 'Не удалось связаться с агентом')); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose} title={created ? `Установка агента — ${created.node.name}` : 'Новая нода'} icon={Server} width={620}
      footer={created ? (
        <>
          <button className="btn" onClick={onClose}>Позже</button>
          <button className="btn solid" disabled={busy} onClick={start}>{busy ? <Spinner size={16} /> : <Play size={15} />} Запустить</button>
        </>
      ) : (
        <>
          <button className="btn" onClick={onClose}>Отмена</button>
          <button className="btn solid" disabled={busy || !name.trim() || !ip.trim()} onClick={create}>{busy ? <Spinner size={16} /> : <KeyRound size={15} />} Получить ключ</button>
        </>
      )}>
      {created ? <InstallSteps secret={created.secret} port={created.node.port} onToast={onToast} /> : (
        <div className="flex flex-col gap-4">
          <div><label className="field-label">Название</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Нидерланды · Aeza #1" autoFocus /></div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2"><label className="field-label">IP-адрес</label><input className="input" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="203.0.113.10" /></div>
            <div><label className="field-label">Порт агента</label><input className="input" type="number" value={port} onChange={(e) => setPort(e.target.value)} /></div>
          </div>
        </div>
      )}
      {err && <div className="badge danger" style={{ marginTop: 14, width: '100%', padding: '10px 12px', justifyContent: 'flex-start', whiteSpace: 'normal' }}>{err}</div>}
    </Modal>
  );
};

export const MonEditModal: React.FC<{ node: MonDetail; onClose: () => void; onSaved: () => void; onToast: (t: string, m: string, ty: ToastType) => void }> = ({ node, onClose, onSaved, onToast }) => {
  const [name, setName] = useState(node.name); const [ip, setIp] = useState(node.ip); const [port, setPort] = useState(String(node.port));
  const [vless, setVless] = useState(''); const [clearVless, setClearVless] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const body: any = { name, ip, port: Number(port) };
      if (vless.trim()) body.vless = vless.trim(); else if (clearVless) body.vless = '';
      await apiFetch(`/panel/monitoring/nodes/${node.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      onToast('Готово', 'Нода сохранена', 'success'); onSaved();
    } catch (e) { setErr(parseApiErr(e, 'Не удалось сохранить')); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose} title="Настройки ноды" icon={Settings} width={600}
      footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn solid" disabled={busy} onClick={save}>{busy ? <Spinner size={16} /> : <Save size={15} />} Сохранить</button></>}>
      <div className="flex flex-col gap-4">
        <div><label className="field-label">Название</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2"><label className="field-label">IP-адрес</label><input className="input" value={ip} onChange={(e) => setIp(e.target.value)} /></div>
          <div><label className="field-label">Порт агента</label><input className="input" type="number" value={port} onChange={(e) => setPort(e.target.value)} /></div>
        </div>
        <div>
          <label className="field-label">VLESS-ключ для проверки {node.vless.configured && <span className="faint" style={{ fontWeight: 400 }}>— сейчас задан ({node.vless.info?.net}/{node.vless.info?.sec})</span>}</label>
          <textarea className="input" rows={3} value={vless} onChange={(e) => { setVless(e.target.value); setClearVless(false); }}
            placeholder={node.vless.configured ? 'Вставьте новый ключ, чтобы заменить' : 'vless://uuid@host:443?type=tcp&security=reality&…'} />
          <div className="sub" style={{ fontSize: 12, marginTop: 6 }}>Раз в 5 минут панель подключается через этот ключ и открывает сайт. Ключ хранится зашифрованным и больше не показывается.</div>
          {node.vless.configured && (
            <label className="flex items-center gap-2 sub" style={{ marginTop: 8, fontSize: 13 }}>
              <input type="checkbox" checked={clearVless} onChange={(e) => { setClearVless(e.target.checked); if (e.target.checked) setVless(''); }} /> Убрать проверку VLESS
            </label>
          )}
        </div>
        {err && <div className="badge danger" style={{ width: '100%', padding: '10px 12px', justifyContent: 'flex-start', whiteSpace: 'normal' }}>{err}</div>}
      </div>
    </Modal>
  );
};

export const MonPayModal: React.FC<{ node: MonDetail; onClose: () => void; onSaved: () => void; onToast: (t: string, m: string, ty: ToastType) => void }> = ({ node, onClose, onSaved, onToast }) => {
  const suggested = (() => {
    const base = node.payment.date ? new Date(node.payment.date) : new Date();
    const d = new Date(base); d.setMonth(d.getMonth() + 1); if (!node.payment.date) d.setHours(12, 0, 0, 0);
    return toLocalInput(d.toISOString());
  })();
  const [date, setDate] = useState(node.payment.date ? suggested : ''); const [url, setUrl] = useState(node.payment.url || '');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const save = async (clear = false) => {
    setBusy(true); setErr('');
    try {
      await apiFetch(`/panel/monitoring/nodes/${node.id}`, { method: 'PATCH', body: JSON.stringify(clear ? { pay_date: '', pay_url: '' } : { pay_date: date ? new Date(date).toISOString() : '', pay_url: url }) });
      onToast('Готово', clear ? 'Напоминания об оплате выключены' : 'Дата оплаты сохранена', 'success'); onSaved();
    } catch (e) { setErr(parseApiErr(e, 'Не удалось сохранить')); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose} title={node.payment.date ? 'Продлить оплату' : 'Оплата сервера'} icon={CreditCard} width={520}
      footer={<>
        {node.payment.date && <button className="btn danger" disabled={busy} onClick={() => save(true)} style={{ marginRight: 'auto' }}>Убрать</button>}
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn solid" disabled={busy || !date} onClick={() => save(false)}>{busy ? <Spinner size={16} /> : <Save size={15} />} Сохранить</button>
      </>}>
      <div className="flex flex-col gap-4">
        <div><label className="field-label">Следующая оплата</label><input className="input" type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div><label className="field-label">Ссылка на оплату</label><input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://my.hosting.com/billing" /></div>
        <div className="sub" style={{ fontSize: 12 }}>Напоминания придут в топик «Инциденты» за 24 часа, за 8 часов и в момент оплаты. После оплаты продлите дату здесь.</div>
        {err && <div className="badge danger" style={{ width: '100%', padding: '10px 12px', justifyContent: 'flex-start', whiteSpace: 'normal' }}>{err}</div>}
      </div>
    </Modal>
  );
};
