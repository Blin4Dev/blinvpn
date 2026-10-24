import React, { useState, useEffect } from 'react';
import {
  CheckCircle, Search, Activity, Plus, ChevronDown, AlertTriangle, Server, ArrowUp, ArrowDown, GripVertical, ArrowUpDown, Check,
} from 'lucide-react';
import { PageHead, Segmented, Spinner, Stat } from '../../components/ui';
import { apiFetch, parseApiErr } from '../../lib/api';
import type { ToastType } from '../../lib/types';
import { MonAddModal } from './NodeModals';
import { NodeDot } from './shared';
import type { MonNodeBrief } from './shared';

export const LoadCell: React.FC<{ v?: number | null }> = ({ v }) => {
  if (v == null) return <span className="faint">—</span>;
  const c = v >= 90 ? 'var(--danger)' : v >= 80 ? '#fb923c' : 'var(--text)';
  return (
    <span className="flex items-center gap-2">
      <span style={{ width: 54, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.1)', overflow: 'hidden', flex: 'none' }}>
        <span style={{ display: 'block', height: '100%', width: `${Math.min(100, Math.max(2, v))}%`, background: c, opacity: v >= 80 ? 1 : 0.7 }} />
      </span>
      <span style={{ color: v >= 80 ? c : undefined, fontVariantNumeric: 'tabular-nums', minWidth: 34 }}>{Math.round(v)}%</span>
    </span>
  );
};

export const MonOverview: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void; onOpen: (id: number) => void }> = ({ onToast, onOpen }) => {
  const [data, setData] = useState<{ summary: any; nodes: (MonNodeBrief & { load?: { cpu?: number | null; ram?: number | null; disk?: number | null } })[] } | null>(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'problems' | 'idle'>('all');
  const [sorting, setSorting] = useState(false);
  const [dragId, setDragId] = useState<number | null>(null);
  const load = async () => { try { setData(await apiFetch('/panel/monitoring')); } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось загрузить мониторинг'), 'error'); } };
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);

  // порядок: переставляем локально сразу, сохраняем на сервере; при ошибке — вернём с сервера
  const saveOrder = async (ids: number[]) => {
    try { await apiFetch('/panel/monitoring/reorder', { method: 'POST', body: JSON.stringify({ ids }) }); }
    catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось сохранить порядок'), 'error'); void load(); }
  };
  const moveTo = (id: number, toIndex: number) => {
    if (!data) return;
    const list = [...data.nodes];
    const from = list.findIndex((n) => n.id === id);
    if (from < 0 || toIndex < 0 || toIndex >= list.length || from === toIndex) return;
    const [item] = list.splice(from, 1);
    list.splice(toIndex, 0, item);
    setData({ ...data, nodes: list });
    void saveOrder(list.map((n) => n.id));
  };
  const startSorting = () => { setQ(''); setFilter('all'); setSorting(true); };

  const nodes = (data?.nodes || [])
    .filter((n) => filter === 'all' || (filter === 'idle' ? n.dot === 'grey' : n.dot === 'red' || n.dot === 'yellow'))
    .filter((n) => !q || `${n.name} ${n.ip}`.toLowerCase().includes(q.toLowerCase()));
  const s = data?.summary;
  return (
    <div className="flex flex-col gap-6">
      {adding && <MonAddModal onClose={() => { setAdding(false); load(); }} onToast={onToast} onOpen={(id) => { setAdding(false); onOpen(id); }} />}
      <PageHead title="Мониторинг" sub="Серверы, нагрузка, доступность и инциденты">
        <button className="btn solid" onClick={() => setAdding(true)}><Plus size={16} /> Добавить ноду</button>
      </PageHead>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat title="Нод всего" value={s ? s.total : '—'} icon={Server} sub={s && s.idle ? `${s.idle} не запущено` : undefined} />
        <Stat title="Работают" value={s ? s.online : '—'} icon={CheckCircle} />
        <Stat title="С проблемами" value={s ? s.problems : '—'} icon={AlertTriangle} />
        <Stat title="Открытых инцидентов" value={s ? s.open_incidents : '—'} icon={Activity} />
      </div>
      <div className="flex flex-col md:flex-row md:items-center gap-3">
        <div className="search flex-1">
          <Search className="ico" size={16} />
          <input className="input" value={q} disabled={sorting} onChange={(e) => setQ(e.target.value)}
            placeholder={sorting ? 'Перетащите строки или используйте стрелки' : 'Название или IP…'} />
        </div>
        <button className={`btn${sorting ? ' solid' : ''}`} disabled={!data || data.nodes.length < 2}
          onClick={() => (sorting ? setSorting(false) : startSorting())} title="Порядок серверов в списке">
          {sorting ? <><Check size={16} /> Готово</> : <><ArrowUpDown size={16} /> Изменить порядок</>}
        </button>
        {!sorting && <Segmented value={filter} onChange={setFilter} options={[
          { value: 'all', label: `Все${s ? ` · ${s.total}` : ''}` },
          { value: 'problems', label: `Проблемы${s ? ` · ${s.problems}` : ''}` },
          { value: 'idle', label: `Не запущены${s ? ` · ${s.idle}` : ''}` },
        ]} />}
      </div>
      <div className="tbl-wrap">
        {!data ? <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl" style={{ minWidth: 720 }}>
              <thead><tr><th>Нода</th><th>IP</th><th>CPU</th><th>RAM</th><th>Диск</th><th /></tr></thead>
              <tbody>
                {nodes.length === 0 ? (
                  <tr className="empty-row"><td colSpan={6}>{data.nodes.length ? 'Ничего не найдено' : 'Нод не добавлено'}</td></tr>
                ) : nodes.map((n, i) => (
                  <tr key={n.id} className={sorting ? undefined : 'click'}
                    onClick={() => { if (!sorting) onOpen(n.id); }}
                    draggable={sorting}
                    onDragStart={(e) => { if (!sorting) return; setDragId(n.id); e.dataTransfer.effectAllowed = 'move'; }}
                    onDragOver={(e) => { if (sorting && dragId !== null) { e.preventDefault(); if (dragId !== n.id) moveTo(dragId, i); } }}
                    onDragEnd={() => setDragId(null)}
                    style={sorting ? { cursor: 'grab', opacity: dragId === n.id ? 0.5 : 1 } : undefined}>
                    <td>
                      <span className="flex items-center gap-3">
                        {sorting && <GripVertical size={16} className="faint" style={{ flex: 'none' }} />}
                        <NodeDot dot={n.dot} reason={n.dot_reason} size={10} />
                        <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }} title={n.dot_reason}>{n.name}</span>
                      </span>
                    </td>
                    <td className="sub" style={{ fontVariantNumeric: 'tabular-nums' }}>{n.ip}</td>
                    <td><LoadCell v={n.load?.cpu} /></td>
                    <td><LoadCell v={n.load?.ram} /></td>
                    <td><LoadCell v={n.load?.disk} /></td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {sorting ? (
                        <span className="flex items-center gap-1" style={{ justifyContent: 'flex-end' }}>
                          <button className="icon-btn" disabled={i === 0} title="Выше" aria-label="Выше"
                            onClick={(e) => { e.stopPropagation(); moveTo(n.id, i - 1); }}><ArrowUp size={15} /></button>
                          <button className="icon-btn" disabled={i === nodes.length - 1} title="Ниже" aria-label="Ниже"
                            onClick={(e) => { e.stopPropagation(); moveTo(n.id, i + 1); }}><ArrowDown size={15} /></button>
                        </span>
                      ) : <ChevronDown size={16} className="faint" style={{ transform: 'rotate(-90deg)' }} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
