import React, { useCallback, useEffect, useState } from 'react';
import { PageHead, Spinner } from '../../components/ui';
import { apiFetch } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { addDays, Day, hoursText, money, monthEnd, monthStart, MonthCalendar, ruDate, ShiftBadge, StatBox } from './common';

// свой график, начисления, штрафы, выплаты
export const SalaryPage: React.FC = () => {
  const [d, setD] = useState<any>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [days, setDays] = useState<Record<string, Day>>({});
  const load = useCallback((m?: string) => {
    const q = m ? `?from=${addDays(monthStart(m), -1)}&to=${monthEnd(m)}` : '';
    apiFetch(`/panel/me/salary${q}`).then((r) => {
      setD(r); if (!m) setMonth(monthStart(r.today));
      setDays(Object.fromEntries((r.schedule as Day[]).map((x) => [x.day, x])));
    }).catch(() => setD({ error: true }));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!d) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  if (d.error) return <div className="sub">Не удалось загрузить</div>;
  const fines = (d.fines || []).filter((f: any) => !f.cancelled);
  const bonuses = (d.bonuses || []).filter((b: any) => !b.cancelled);
  return (
    <div className="flex flex-col gap-5">
      <PageHead title="Зарплата" sub="Посуточная оплата, премии и штрафы, выплата раз в неделю. Время — московское">
        <ShiftBadge shift={d.shift} />
      </PageHead>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatBox label="Мой баланс" value={money(d.balance)} hint="начислено + премии − штрафы − выплаты" />
        <StatBox label="На этой неделе" value={money(d.earned_this_week)} />
        <StatBox label="Премии / штрафы" value={`+${money(d.bonused || 0)} / −${money(d.fined)}`} />
        <StatBox label="Получено, всего" value={money(d.paid)} />
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="card xl:col-span-2" style={{ padding: 16 }}>
          <div className="h-sec" style={{ marginBottom: 10 }}>Мой график</div>
          {month && <MonthCalendar month={month} today={d.today} days={days} showPay onMonth={(m) => { setMonth(m); load(m); }} />}
        </div>
        <div className="flex flex-col gap-4">
          {bonuses.length > 0 && (
            <div className="card" style={{ padding: 16 }}><div className="h-sec" style={{ marginBottom: 8 }}>Премии</div>
              {bonuses.map((b: any) => (
                <div key={b.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                  <div className="flex justify-between gap-2"><span>{b.reason}</span><span style={{ color: '#34d399', flex: 'none' }}>+{money(b.amount)}</span></div>
                  <div className="faint" style={{ fontSize: 11 }}>{fmtDateTime(b.created_at).slice(0, 16)}</div>
                </div>))}
            </div>
          )}
          <div className="card" style={{ padding: 16 }}><div className="h-sec" style={{ marginBottom: 8 }}>Штрафы</div>
            {fines.length === 0 ? <div className="sub" style={{ fontSize: 13 }}>Штрафов нет 👍</div> : fines.map((f: any) => (
              <div key={f.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                <div className="flex justify-between gap-2"><span>{f.reason}</span><span style={{ color: 'var(--danger)', flex: 'none' }}>−{money(f.amount)}</span></div>
                <div className="faint" style={{ fontSize: 11 }}>{fmtDateTime(f.created_at).slice(0, 16)}</div>
              </div>))}
          </div>
          <div className="card" style={{ padding: 16 }}><div className="h-sec" style={{ marginBottom: 8 }}>Выплаты</div>
            {(d.payouts || []).length === 0 ? <div className="sub" style={{ fontSize: 13 }}>Выплат ещё не было</div> : d.payouts.map((p: any) => (
              <div key={p.id} className="flex justify-between gap-2" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                <span>{ruDate(p.paid_on)}{p.note ? <span className="faint"> · {p.note}</span> : null}</span><span>{money(p.amount)}</span>
              </div>))}
          </div>
          <div className="card" style={{ padding: 16 }}><div className="h-sec" style={{ marginBottom: 8 }}>Начислено</div>
            {(d.days || []).length === 0 ? <div className="sub" style={{ fontSize: 13 }}>Пока нет отработанных дней</div> : d.days.slice(0, 14).map((x: Day) => (
              <div key={x.day} className="flex justify-between gap-2" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                <span>{ruDate(x.day)} <span className="faint">{hoursText(x.intervals)}</span></span><span>+{money(x.pay || 0)}</span>
              </div>))}
          </div>
        </div>
      </div>
    </div>
  );
};
