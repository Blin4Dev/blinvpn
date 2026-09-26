import React, { useState, useEffect } from 'react';
import {
  CheckCircle, Search, Activity, Plus, ChevronDown, AlertTriangle, Server,
} from 'lucide-react';
import { PageHead, Segmented, Spinner, Stat } from '../../components/ui';
import { apiFetch, parseApiErr } from '../../lib/api';
import type { ToastType } from '../../lib/types';
import { MonAddModal } from './NodeModals';
import { MON_COLORS, StatusDot } from './shared';
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
  const load = async () => { try { setData(await apiFetch('/panel/monitoring')); } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось загрузить мониторинг'), 'error'); } };
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);
  const nodes = (data?.nodes || [])
    .filter((n) => filter === 'all' || (filter === 'idle' ? n.status === 'idle' : n.status !== 'green' && n.status !== 'idle'))
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
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название или IP…" />
        </div>
        <Segmented value={filter} onChange={setFilter} options={[
          { value: 'all', label: `Все${s ? ` · ${s.total}` : ''}` },
          { value: 'problems', label: `Проблемы${s ? ` · ${s.problems}` : ''}` },
          { value: 'idle', label: `Не запущены${s ? ` · ${s.idle}` : ''}` },
        ]} />
      </div>
      <div className="tbl-wrap">
        {!data ? <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl" style={{ minWidth: 820 }}>
              <thead><tr><th>Нода</th><th>IP</th><th>Статус</th><th>CPU</th><th>RAM</th><th>Диск</th><th /></tr></thead>
              <tbody>
                {nodes.length === 0 ? (
                  <tr className="empty-row"><td colSpan={7}>{data.nodes.length ? 'Ничего не найдено' : 'Нод пока нет. Добавьте первый сервер — панель выдаст ключ для агента.'}</td></tr>
                ) : nodes.map((n) => (
                  <tr key={n.id} className="click" onClick={() => onOpen(n.id)}>
                    <td>
                      <span className="flex items-center gap-3">
                        <StatusDot s={n.status} size={9} />
                        <span style={{ fontWeight: 500 }}>{n.name}</span>
                      </span>
                    </td>
                    <td className="sub" style={{ fontVariantNumeric: 'tabular-nums' }}>{n.ip}</td>
                    <td><span className="sub" style={{ color: n.status === 'green' || n.status === 'idle' ? undefined : MON_COLORS[n.status] }}>{n.status_label}</span></td>
                    <td><LoadCell v={n.load?.cpu} /></td>
                    <td><LoadCell v={n.load?.ram} /></td>
                    <td><LoadCell v={n.load?.disk} /></td>
                    <td style={{ textAlign: 'right' }}><ChevronDown size={16} className="faint" style={{ transform: 'rotate(-90deg)' }} /></td>
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
