import React, { useState, useEffect } from 'react';
import {
  DollarSign, Key, CheckCircle, AlertCircle, UserPlus, Bell, ChevronDown, AlertTriangle, BarChart2,
} from 'lucide-react';
import { Kpi, PageHead, Spinner } from '../components/ui';
import { apiFetch } from '../lib/api';
import { fmtInt, fmtMoney } from '../lib/format';

export const TODO_STYLE: Record<string, { c: string; icon: React.ElementType }> = {
  critical: { c: 'var(--danger)', icon: AlertCircle },
  warning: { c: '#fb923c', icon: AlertTriangle },
  info: { c: 'var(--muted)', icon: Bell },
};

export const Dashboard: React.FC<{ onNavigate: (page: string) => void; onOpenUser: (id: number) => void }> = ({ onNavigate }) => {
  const [d, setD] = useState<any>(null);
  const load = async () => { try { setD(await apiFetch('/panel/dashboard')); } catch (e) { console.error(e); } };
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);
  const today = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const head = (
    <PageHead title="Главная" sub={today.charAt(0).toUpperCase() + today.slice(1)}>
      <button className="btn" onClick={() => onNavigate('Статистика')}><BarChart2 size={16} /> Статистика</button>
    </PageHead>
  );
  if (!d) return <div className="flex flex-col gap-6">{head}<div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}><Spinner size={24} /></div></div>;
  const r = d.revenue;
  return (
    <div className="flex flex-col gap-6" style={{ maxWidth: 1000 }}>
      {head}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Kpi title="Заработано сегодня" icon={DollarSign} value={fmtMoney(r.today)} foot={`вчера к этому часу — ${fmtMoney(r.yesterday_same_time)}`} />
        <Kpi title="Новых сегодня" icon={UserPlus} value={`+${fmtInt(d.users.today)}`} foot={`вчера +${fmtInt(d.users.yesterday)}`} />
        <Kpi title="Активных подписок" icon={Key} value={fmtInt(d.subs.active_paid)} foot={`и ${fmtInt(d.subs.active_trial)} пробных`} />
      </div>

      <div className="card" style={{ padding: 20 }}>
        <h3 className="h-sec mb-4">Нужно сделать</h3>
        {d.todo.length === 0 ? (
          <div className="flex items-center gap-3 sub">
            <CheckCircle size={18} style={{ color: '#34d399' }} /> Всё спокойно — делать ничего не нужно.
          </div>
        ) : (
          <div className="flex flex-col">
            {d.todo.map((t: any, i: number) => {
              const S = TODO_STYLE[t.level] || TODO_STYLE.info;
              return (
                <button key={i} className="flex items-center gap-3 todo-row" onClick={() => onNavigate(t.page)}
                  style={{ padding: '12px 4px', textAlign: 'left', width: '100%', cursor: 'pointer', background: 'none', border: 'none', borderTop: i ? '1px solid var(--border)' : 'none', color: 'inherit' }}>
                  <S.icon size={17} style={{ color: S.c, flex: 'none' }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 500 }}>{t.title}</span>
                    <span className="sub" style={{ fontSize: 13 }}> — {t.text}</span>
                  </span>
                  <ChevronDown size={16} className="faint" style={{ transform: 'rotate(-90deg)', flex: 'none' }} />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
