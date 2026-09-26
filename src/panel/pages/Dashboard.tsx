import React, { useState, useEffect } from 'react';
import {
  DollarSign, CheckCircle, AlertCircle, Bell, ChevronDown, AlertTriangle, BarChart2, Users, Zap, Clock,
} from 'lucide-react';
import { Legend, LineChart } from '../components/charts';
import { Delta, Kpi, PageHead, Panel, Spinner } from '../components/ui';
import { apiFetch } from '../lib/api';
import { fmtInt, fmtMoney, hoursStr, pctStr } from '../lib/format';

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
  const ub = d.users_block;
  const times = (ub?.timeline || []).map((x: any) => Date.parse(x.t + 'T00:00:00+03:00') / 1000);
  return (
    <div className="flex flex-col gap-6">
      {head}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi title="Всего пользователей" icon={Users} value={fmtInt(ub.users.total)}
          foot={`${fmtInt(ub.users.banned)} забанено · ${fmtInt(ub.users.blacklisted)} в чёрном списке`} />
        <Kpi title={`Доход за ${r.month_name}`} icon={DollarSign} value={fmtMoney(r.cal_month)}
          foot={<Delta v={r.cal_month_delta} suffix="к прошлому месяцу" />}
          hint={`Прошлый месяц к этому же дню — ${fmtMoney(r.prev_month_same)}, за весь прошлый месяц — ${fmtMoney(r.prev_month)}`} />
        <Kpi title="Оплатили после пробного" icon={Zap} value={pctStr(ub.funnel.trial_conv_all)}
          foot={`за всё время · из ${fmtInt(ub.funnel.trial_total)} взявших пробный`} />
        <Kpi title="От регистрации до оплаты" icon={Clock} value={hoursStr(ub.funnel.hours_to_pay_median)}
          foot="обычно проходит столько времени" />
      </div>

      <Panel title="Новые пользователи, пробные и первые покупки за 30 дней">
        <LineChart range="7d" times={times} height={200} format={(v) => fmtInt(v)}
          series={[
            { name: 'новые', color: '#fff', values: ub.timeline.map((x: any) => x.new_users) },
            { name: 'пробные', color: '#60a5fa', values: ub.timeline.map((x: any) => x.trials) },
            { name: 'первые покупки', color: '#34d399', values: ub.timeline.map((x: any) => x.first) },
          ]} />
        <div style={{ marginTop: 10 }}><Legend items={[{ name: 'новые', color: '#fff' }, { name: 'пробные', color: '#60a5fa' }, { name: 'первые покупки', color: '#34d399' }]} /></div>
      </Panel>

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
