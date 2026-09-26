import React, { useState, useEffect } from 'react';
import {
  Download, Save, Cloud,
} from 'lucide-react';
import { Spinner, Toggle } from '../../components/ui';
import { apiFetch, getPanelToken } from '../../lib/api';
import type { ToastType } from '../../lib/types';

export type BackupFile = { name: string; size: number; created_at: string };

export const BackupSettingsTab: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [enabled, setEnabled] = useState(false);
  const [interval, setInterval] = useState('12');
  const [lastBackup, setLastBackup] = useState<string | null>(null);
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [creating, setCreating] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);

  const loadStatus = async () => {
    try { const d = await apiFetch('/panel/backups/status'); if (d) { setEnabled(d.enabled || false); setInterval(d.interval_hours?.toString() || '12'); setLastBackup(d.last_backup || null); setBackups(Array.isArray(d.backups) ? d.backups : []); } }
    catch (e) { console.error(e); }
  };
  useEffect(() => { loadStatus(); }, []);

  const createNow = async () => { setCreating(true); try { const d = await apiFetch('/panel/backups/create', { method: 'POST' }); onToast('Готово', 'Резервная копия создана', 'success'); if (d && Array.isArray(d.backups)) { setBackups(d.backups); setLastBackup(d.last_backup || d.created_at || null); } else loadStatus(); } catch { onToast('Ошибка', 'Не удалось создать копию', 'error'); } setCreating(false); };
  const saveSettings = async () => { try { await apiFetch('/panel/backups/settings', { method: 'PUT', body: JSON.stringify({ enabled, interval_hours: parseInt(interval) }) }); onToast('Готово', 'Настройки сохранены', 'success'); } catch { onToast('Ошибка', 'Не удалось сохранить', 'error'); } };

  const download = async (name: string) => {
    setDownloading(name);
    try {
      const res = await fetch(`/api/panel/backups/download?name=${encodeURIComponent(name)}`, { headers: { Authorization: `Bearer ${getPanelToken()}` } });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch { onToast('Ошибка', 'Не удалось скачать копию', 'error'); }
    setDownloading(null);
  };

  const fmtSize = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`;

  return (
    <div className="card" style={{ padding: 24 }}>
      <h3 className="h-sec" style={{ paddingBottom: 16, borderBottom: '1px solid var(--border)', marginBottom: 20 }}>Резервное копирование</h3>
      <div className="flex flex-col gap-5">
        <div className="inset flex items-center justify-between gap-3" style={{ padding: 14 }}>
          <div><div style={{ fontWeight: 500 }}>Автоматическое копирование</div><div className="sub mt-0.5">Копии базы создаются на сервере по расписанию</div></div>
          <Toggle on={enabled} onChange={() => setEnabled(!enabled)} />
        </div>
        <div><label className="field-label">Частота, часов</label><input className="input" type="number" value={interval} onChange={(e) => setInterval(e.target.value)} placeholder="12" /></div>
        {lastBackup && <div className="inset" style={{ padding: 12 }}><span className="sub">Последняя копия: </span><span>{new Date(lastBackup).toLocaleString('ru-RU')}</span></div>}
        <div className="flex gap-3">
          <button className="btn solid block" onClick={createNow} disabled={creating}>{creating ? <Spinner size={16} /> : <Cloud size={16} />} Создать сейчас</button>
          <button className="btn block" onClick={saveSettings}><Save size={16} /> Сохранить настройки</button>
        </div>

        <div>
          <div className="field-label" style={{ marginBottom: 8 }}>Копии на сервере ({backups.length})</div>
          {backups.length === 0 ? <div className="sub inset" style={{ padding: 12 }}>Копий пока нет. Нажмите «Создать сейчас».</div>
            : <div className="flex flex-col gap-2">{backups.map((b) => (
                <div key={b.name} className="inset flex items-center justify-between gap-3" style={{ padding: '10px 14px' }}>
                  <div style={{ minWidth: 0 }}><div className="mono" style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.name}</div><div className="sub" style={{ fontSize: 12 }}>{new Date(b.created_at).toLocaleString('ru-RU')} · {fmtSize(b.size)}</div></div>
                  <button className="btn sm" onClick={() => download(b.name)} disabled={downloading === b.name}>{downloading === b.name ? <Spinner size={14} /> : <Download size={14} />} Скачать</button>
                </div>
              ))}</div>}
        </div>
      </div>
    </div>
  );
};
