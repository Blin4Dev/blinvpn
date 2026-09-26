import React, { useState, useEffect } from 'react';
import {
  Edit2, Zap, RefreshCw,
} from 'lucide-react';
import { Modal, PageHead, Spinner } from '../../components/ui';
import { apiFetch } from '../../lib/api';
import type { ToastType } from '../../lib/types';

export interface SquadConfig {
  id: number; squad_uuid: string; squad_name: string; squad_type: string;
  max_users: number; current_users: number; inbounds_count?: number; is_active: boolean; priority: number;
}

export const SquadsPage: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [squads, setSquads] = useState<SquadConfig[]>([]);
  const [mapping, setMapping] = useState<{ vpn: string[]; trial: string[] }>({ vpn: [], trial: [] });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState<SquadConfig | null>(null);

  const load = async () => {
    try { const d = await apiFetch('/panel/squads'); if (d) { setSquads(d.squads || []); setMapping({ vpn: d.mapping?.vpn || [], trial: d.mapping?.trial || [] }); } }
    catch { onToast('Ошибка', 'Не удалось загрузить сквады', 'error'); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const sync = async () => {
    setSyncing(true);
    try { const r = await apiFetch('/panel/squads/sync', { method: 'POST' }); if (r?.success) { onToast('Готово', `Синхронизировано ${r.count} сквадов`, 'success'); load(); } else onToast('Ошибка', r?.error || 'Ошибка синхронизации', 'error'); }
    catch { onToast('Ошибка', 'Не удалось синхронизировать', 'error'); } finally { setSyncing(false); }
  };
  const saveSquad = async (squad: SquadConfig) => {
    try { const r = await apiFetch(`/panel/squads/${squad.squad_uuid}`, { method: 'PUT', body: JSON.stringify({ squad_name: squad.squad_name, squad_type: squad.squad_type, max_users: squad.max_users, priority: squad.priority, is_active: squad.is_active }) }); if (r?.success) { onToast('Готово', 'Сквад обновлён', 'success'); setEditing(null); load(); } }
    catch { onToast('Ошибка', 'Не удалось сохранить', 'error'); }
  };
  const saveMapping = async () => { try { const r = await apiFetch('/panel/squads/mapping', { method: 'PUT', body: JSON.stringify(mapping) }); if (r?.success) onToast('Готово', 'Привязки сохранены', 'success'); } catch { onToast('Ошибка', 'Не удалось сохранить привязки', 'error'); } };
  const toggleMapping = (type: 'vpn' | 'trial', uuid: string) => setMapping((prev) => { const cur = prev[type] || []; return { ...prev, [type]: cur.includes(uuid) ? cur.filter((u) => u !== uuid) : [...cur, uuid] }; });

  if (loading) return <div className="flex items-center justify-center" style={{ height: 240 }}><Spinner size={28} /></div>;

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Сквады" sub="Распределение нагрузки по серверам">
        <button className="btn solid" onClick={sync} disabled={syncing}>{syncing ? <Spinner size={16} /> : <RefreshCw size={16} />} Синхронизировать</button>
      </PageHead>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {squads.map((sq) => {
          const pct = sq.max_users > 0 ? Math.min(100, (sq.current_users / sq.max_users) * 100) : 0;
          return (
            <div key={sq.squad_uuid} className="card card-hover" style={{ padding: 18, opacity: sq.is_active ? 1 : 0.5 }}>
              <div className="flex justify-between items-start mb-3">
                <div><h3 style={{ fontWeight: 600 }}>{sq.squad_name}</h3><span className="badge line mt-1" style={{ marginTop: 6 }}>{sq.squad_type.toUpperCase()}</span></div>
                <button className="icon-btn" onClick={() => setEditing(sq)}><Edit2 size={15} /></button>
              </div>
              <div className="flex flex-col gap-2" style={{ fontSize: 14 }}>
                <div className="flex justify-between"><span className="muted">Пользователей</span><span style={{ fontWeight: 500 }}>{sq.current_users}{sq.max_users > 0 && ` / ${sq.max_users}`}</span></div>
                {sq.inbounds_count != null && <div className="flex justify-between"><span className="muted">Инбаундов</span><span>{sq.inbounds_count}</span></div>}
                <div className="flex justify-between"><span className="muted">Приоритет</span><span>{sq.priority}</span></div>
                {sq.max_users > 0 && <div className="meter mt-1"><i style={{ width: `${pct}%` }} /></div>}
              </div>
            </div>
          );
        })}
      </div>

      {squads.length === 0 && (
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <Zap size={40} className="faint" style={{ margin: '0 auto 12px' }} />
          <h3 className="h-sec mb-2">Нет сквадов</h3>
          <p className="sub mb-4">Синхронизируйте сквады с Remnawave</p>
          <button className="btn solid" onClick={sync} style={{ margin: '0 auto' }}>Синхронизировать</button>
        </div>
      )}

      {squads.length > 0 && (
        <div className="card" style={{ padding: 24 }}>
          <h3 className="h-sec mb-2">Привязка сквадов к типам подписок</h3>
          <p className="sub mb-6">Система выберет сквад с наименьшей нагрузкой из выбранных для каждого типа.</p>
          <div className="flex flex-col gap-5">
            {(['vpn', 'trial'] as const).map((type) => (
              <div key={type}>
                <h4 className="mb-3" style={{ fontWeight: 500 }}>{type === 'vpn' ? 'Подписка (VPN + обход блокировок)' : 'Пробный период'}</h4>
                <div className="flex flex-wrap gap-2">
                  {squads.filter((s) => s.is_active).map((sq) => (
                    <button key={sq.squad_uuid} className={`chip ${mapping[type]?.includes(sq.squad_uuid) ? 'on' : ''}`} onClick={() => toggleMapping(type, sq.squad_uuid)}>{sq.squad_name}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <button className="btn solid mt-6" onClick={saveMapping}>Сохранить привязки</button>
        </div>
      )}

      {editing && (
        <Modal onClose={() => setEditing(null)} title="Редактирование сквада" width={440}
          footer={<><button className="btn block" onClick={() => setEditing(null)}>Отмена</button><button className="btn solid block" onClick={() => saveSquad(editing)}>Сохранить</button></>}>
          <div className="flex flex-col gap-4">
            <div><label className="field-label">Название</label><input className="input" value={editing.squad_name} onChange={(e) => setEditing({ ...editing, squad_name: e.target.value })} /></div>
            <div><label className="field-label">Тип</label><select className="select" value={editing.squad_type} onChange={(e) => setEditing({ ...editing, squad_type: e.target.value })}><option value="vpn">Подписка (VPN + обход)</option><option value="trial">Trial (пробный)</option></select></div>
            <div><label className="field-label">Макс. пользователей (0 = без лимита)</label><input className="input" type="number" value={editing.max_users} onChange={(e) => setEditing({ ...editing, max_users: parseInt(e.target.value) || 0 })} /></div>
            <div><label className="field-label">Приоритет</label><input className="input" type="number" value={editing.priority} onChange={(e) => setEditing({ ...editing, priority: parseInt(e.target.value) || 0 })} /></div>
            <label className="flex items-center gap-2 muted" style={{ fontSize: 13, cursor: 'pointer' }}><input type="checkbox" checked={editing.is_active} onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })} /> Активен</label>
          </div>
        </Modal>
      )}
    </div>
  );
};
