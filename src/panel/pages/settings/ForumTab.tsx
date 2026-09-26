import React, { useState, useEffect } from 'react';
import {
  Send, Save,
} from 'lucide-react';
import { Spinner } from '../../components/ui';
import { apiFetch } from '../../lib/api';
import type { ToastType } from '../../lib/types';

export const FORUM_TOPICS: { id: string; label: string; hint: string }[] = [
  { id: 'withdrawals', label: 'Выводы', hint: 'запросы на вывод + кнопка «Одобрить»' },
  { id: 'codes', label: 'Коды', hint: 'коды входа в панель' },
  { id: 'backups', label: 'Бэкапы', hint: 'файлы резервных копий БД' },
  { id: 'purchases', label: 'Покупки', hint: 'уведомления об оплатах' },
  { id: 'errors', label: 'Ошибки', hint: 'серверные ошибки' },
  { id: 'incidents', label: 'Инциденты', hint: 'мониторинг серверов и напоминания об оплате' },
];

export const ForumSettingsTab: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [chatId, setChatId] = useState('');
  const [panelUrl, setPanelUrl] = useState('');
  const [topics, setTopics] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const d = await apiFetch('/panel/forum');
      setChatId(d?.forum_chat_id || '');
      setPanelUrl(d?.panel_url || '');
      setTopics(d?.topics || {});
    } catch { onToast('Ошибка', 'Не удалось загрузить настройки форума', 'error'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch('/panel/forum', { method: 'PUT', body: JSON.stringify({ forum_chat_id: chatId.trim(), panel_url: panelUrl.trim(), topics }) });
      onToast('Готово', 'Настройки форума сохранены', 'success');
    } catch { onToast('Ошибка', 'Не удалось сохранить', 'error'); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="card" style={{ padding: 24 }}><Spinner size={24} /></div>;

  return (
    <div className="card" style={{ padding: 24 }}>
      <h3 className="h-sec" style={{ paddingBottom: 16, borderBottom: '1px solid var(--border)', marginBottom: 20 }}>Группа-форум Telegram</h3>
      <div className="flex flex-col gap-5">
        <div className="inset flex items-start gap-3" style={{ padding: 14 }}>
          <Send size={18} className="faint" style={{ marginTop: 2, flex: 'none' }} />
          <div className="sub" style={{ fontSize: 13 }}>Создайте группу с топиками (форум), добавьте бота админом. Укажите ID группы (например <span className="mono">-1001234567890</span>) и ID каждого топика. Если не задать — коды/уведомления придут администратору в ЛС.</div>
        </div>
        <div><label className="field-label">ID группы-форума</label><input className="input mono" value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="-1001234567890" /></div>
        <div><label className="field-label">URL панели (для кликабельных id в уведомлениях)</label><input className="input mono" value={panelUrl} onChange={(e) => setPanelUrl(e.target.value)} placeholder="https://panel.blinvpn.cc" /></div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {FORUM_TOPICS.map((t) => (
            <div key={t.id}>
              <label className="field-label">Топик «{t.label}» <span className="faint" style={{ fontWeight: 400 }}>— {t.hint}</span></label>
              <input className="input mono" type="number" value={topics[t.id] ?? ''} onChange={(e) => setTopics({ ...topics, [t.id]: e.target.value })} placeholder="ID топика" />
            </div>
          ))}
        </div>
        <button className="btn solid" style={{ alignSelf: 'flex-start' }} onClick={save} disabled={saving}>{saving ? <Spinner size={16} /> : <Save size={16} />} Сохранить</button>
      </div>
    </div>
  );
};
