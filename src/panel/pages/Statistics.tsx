import React, { useState, useEffect } from 'react';
import {
  DollarSign, Users, Key, Gift, CreditCard, Hash, Trophy, UserPlus, Clock, Smartphone, Zap, Wallet, RefreshCw,
} from 'lucide-react';
import { Columns, Funnel, HBarChart, Legend, LineChart } from '../components/charts';
import { Delta, Kpi, PageHead, Panel, Row, Segmented, Spinner, StatSection } from '../components/ui';
import { apiFetch } from '../lib/api';
import { fmtInt, fmtMoney, gb, hoursStr, pctStr, toSeries } from '../lib/format';

export const PERIOD_OPTS = [
  { value: '7d', label: '7 дней' }, { value: '30d', label: '30 дней' }, { value: '90d', label: '90 дней' },
  { value: '365d', label: 'Год' }, { value: 'all', label: 'Всё время' },
] as const;

export type StatPeriod = typeof PERIOD_OPTS[number]['value'];

export const StatisticsPage: React.FC<{ onOpenUser: (id: number) => void }> = ({ onOpenUser }) => {
  const [period, setPeriod] = useState<StatPeriod>('30d');
  const [s, setS] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true; setLoading(true);
    apiFetch(`/panel/statistics?period=${period}`).then((d) => { if (alive) setS(d); }).catch(console.error).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [period]);

  const head = (
    <PageHead title="Статистика" sub={s ? `${new Date(s.from).toLocaleDateString('ru-RU')} — ${new Date(s.to).toLocaleDateString('ru-RU')} · по московскому времени` : 'Деньги, пользователи, подписки, рефералы'}>
      <div className="flex items-center gap-3">{loading && s && <Spinner size={16} />}<Segmented value={period} onChange={setPeriod} options={PERIOD_OPTS as any} /></div>
    </PageHead>
  );
  if (!s) return <div className="flex flex-col gap-6">{head}<div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}><Spinner size={24} /></div></div>;

  const m = s.money; const u = s.users; const f = s.funnel; const sb = s.subs; const rf = s.referrals;
  const times = s.timeline.map((x: any) => Date.parse(x.t + 'T00:00:00+03:00') / 1000);
  const bucketName = s.bucket === 'day' ? 'по дням' : s.bucket === 'week' ? 'по неделям' : 'по месяцам';
  const cmp = period === 'all' ? '' : 'к прошлому периоду';
  const sumPairs = (rows: any[]) => rows.map((r: any) => ({ label: `${r.name} · ${fmtInt(r.count)}`, value: r.sum }));

  return (
    <div className="flex flex-col gap-8" style={{ opacity: loading ? 0.6 : 1, transition: 'opacity .2s' }}>
      {head}

      <StatSection title="Деньги" sub="Только успешные платежи. Оплаты звёздами посчитаны в рублях по цене тарифа.">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Kpi title="Выручка" icon={DollarSign} value={fmtMoney(m.revenue)} foot={period === 'all' ? `≈ ${fmtMoney(m.per_day)} в день` : <Delta v={m.revenue_delta} suffix={cmp} />} />
          <Kpi title="Платежей" icon={CreditCard} value={fmtInt(m.payments)} foot={period === 'all' ? `${fmtInt(m.failed)} неуспешных` : <Delta v={m.payments_delta} suffix={cmp} />} />
          <Kpi title="Средний чек" icon={Hash} value={fmtMoney(m.avg_check)} foot={`обычно платят ${fmtMoney(m.median_check)}`} hint="«Обычно платят» — сумма посередине: половина платежей меньше, половина больше" />
          <Kpi title="Людей заплатило" icon={Users} value={fmtInt(m.payers)} foot={period === 'all' ? '' : <Delta v={m.payers_delta} suffix={cmp} />} />
          <Kpi title="Доход с одного платящего" value={fmtMoney(m.arppu)} foot="в среднем за выбранный период" />
          <Kpi title="Доход с клиента за всё время" value={fmtMoney(m.ltv)} foot={`в среднем · всего заработано ${fmtMoney(m.total_all_time)}`} />
          <Kpi title="Успешность оплат" value={pctStr(m.success_rate)} foot={`${fmtInt(m.failed)} неуспешных попыток`} />
          <Kpi title="Возвраты" value={fmtMoney(m.refunds_sum)} foot={`${fmtInt(m.refunds)} шт. за период`} />
        </div>

        <Panel title={`Выручка ${bucketName}`} right={m.best && m.best.revenue > 0 ? <span className="sub" style={{ fontSize: 13 }}>лучший: {m.best.label} — {fmtMoney(m.best.revenue)} · в среднем {fmtMoney(m.per_day)}/день</span> : null}>
          <Columns height={200} every={Math.max(1, Math.ceil(s.timeline.length / 12))} format={fmtMoney}
            data={s.timeline.map((x: any) => ({ label: x.label, value: x.revenue, sub: `${fmtInt(x.payments)} платежей · первых покупок ${fmtInt(x.first)}` }))} />
        </Panel>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Panel title="За что платят"><HBarChart data={sumPairs(s.by_kind)} format={fmtMoney} /></Panel>
          <Panel title="Способы оплаты"><HBarChart data={sumPairs(s.by_method)} format={fmtMoney} /></Panel>
          <Panel title="Тарифы (устройств)"><HBarChart data={toSeries(s.by_plan)} format={fmtInt} /></Panel>
          <Panel title="Отказы по способам оплаты">
            {s.fail_by_method.length === 0 ? <p className="sub">Попыток оплаты не было</p> : s.fail_by_method.map((r: any) => (
              <Row key={r.name} k={r.name} v={<>{pctStr(r.rate)} <span className="faint">· {r.failed} из {r.total}</span></>} />
            ))}
            {s.by_months.length > 1 && <div style={{ marginTop: 16 }}><div className="sub mb-2" style={{ fontSize: 13 }}>Срок оплаты</div><HBarChart data={toSeries(s.by_months)} format={fmtInt} /></div>}
          </Panel>
          <Panel title="Когда платят — час (МСК)">
            <Columns data={s.by_hour.map((v: number, h: number) => ({ label: String(h), value: v, sub: `${h}:00–${h}:59` }))} format={(v) => `${fmtInt(v)} платежей`} height={130} every={3} />
          </Panel>
          <Panel title="Когда платят — день недели">
            <Columns data={s.by_weekday.map((x: any) => ({ label: x.name, value: x.value }))} format={(v) => `${fmtInt(v)} платежей`} height={130} />
          </Panel>
        </div>
      </StatSection>

      <StatSection title="Пользователи" sub="«Путь пользователя» считается по тем, кто пришёл за выбранный период.">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Kpi title="Всего пользователей" icon={Users} value={fmtInt(u.total)} foot={`${fmtInt(u.banned)} забанено · ${fmtInt(u.blacklisted)} в чёрном списке`} />
          <Kpi title="Новых" icon={UserPlus} value={`+${fmtInt(u.new)}`} foot={period === 'all' ? '' : <Delta v={u.new_delta} suffix={cmp} />} />
          <Kpi title="Оплатили после пробного" icon={Zap} value={pctStr(f.trial_conv_all)} foot={`за всё время · из ${fmtInt(f.trial_total)} взявших пробный`} />
          <Kpi title="От регистрации до оплаты" icon={Clock} value={hoursStr(f.hours_to_pay_median)} foot="обычно проходит столько времени" />
        </div>
        <Panel title={`Новые пользователи, пробные и первые покупки ${bucketName}`}>
          <LineChart range="7d" times={times} height={200} format={(v) => fmtInt(v)}
            series={[
              { name: 'новые', color: '#fff', values: s.timeline.map((x: any) => x.new_users) },
              { name: 'пробные', color: '#60a5fa', values: s.timeline.map((x: any) => x.trials) },
              { name: 'первые покупки', color: '#34d399', values: s.timeline.map((x: any) => x.first) },
            ]} />
          <div style={{ marginTop: 10 }}><Legend items={[{ name: 'новые', color: '#fff' }, { name: 'пробные', color: '#60a5fa' }, { name: 'первые покупки', color: '#34d399' }]} /></div>
        </Panel>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Panel title="Путь пользователя" className="lg:col-span-1">
            <Funnel steps={[{ label: 'Пришли', value: f.registered }, { label: 'Взяли пробный', value: f.trial }, { label: 'Оплатили', value: f.paid }]} />
          </Panel>
          <Panel title="Откуда пришли"><HBarChart data={toSeries(u.sources)} format={fmtInt} /></Panel>
          <Panel title="Пользователи по статусу"><HBarChart data={toSeries(sb.state_dist)} format={fmtInt} dangerLabels={['Забанен']} /></Panel>
          <Panel title="Как входят"><HBarChart data={toSeries(u.login)} format={fmtInt} /></Panel>
          <Panel title="Балансы">
            <Row k="С деньгами на балансе" v={fmtInt(u.with_balance)} />
            <Row k="Сумма балансов клиентов" v={fmtMoney(u.balance_total)} />
            <Row k="За приглашения, не выведено" v={fmtMoney(rf.owed)} />
          </Panel>
          <Panel title="Промокоды" right={<span className="sub" style={{ fontSize: 13 }}>{fmtInt(s.promo.activations)} активаций</span>}>
            {s.promo.top.length ? <HBarChart data={toSeries(s.promo.top)} format={fmtInt} /> : <p className="sub">За период промокоды не активировали</p>}
          </Panel>
        </div>
      </StatSection>

      <StatSection title="Подписки">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Kpi title="Платные активные" icon={Key} value={fmtInt(sb.active_paid)} foot={`+ ${fmtInt(sb.active_trial)} пробных`} />
          <Kpi title="Устройств оплачено" icon={Smartphone} value={fmtInt(sb.devices_total)} foot={`в среднем ${sb.avg_devices} на подписку`} />
          <Kpi title="Продлений" icon={RefreshCw} value={fmtInt(sb.renewed_period)} foot={`истекло за период: ${fmtInt(sb.expired_period)}`} />
          <Kpi title="Покупают повторно" icon={Trophy} value={pctStr(sb.repeat_rate)} foot={`платили 2 раза и больше · из ${fmtInt(sb.paying_all)}`} />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Panel title="Скоро истекают">
            <Row k="В течение суток" v={fmtInt(sb.exp_24h)} />
            <Row k="В течение 3 дней" v={fmtInt(sb.exp_3d)} />
            <Row k="В течение 7 дней" v={fmtInt(sb.exp_7d)} />
            <Row k="С запретом продления" v={fmtInt(sb.no_renew)} />
            <Row k="Заморожены" v={fmtInt(sb.frozen)} />
            <Row k="Трафик активных подписок" v={`${gb(sb.traffic_total).toFixed(1)} ГБ`} />
          </Panel>
          <Panel title="Сколько устройств в подписках"><HBarChart data={toSeries(sb.devices_dist)} format={fmtInt} /></Panel>
        </div>
      </StatSection>

      <StatSection title="Рефералы и ссылки">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Kpi title="Приглашено" icon={UserPlus} value={fmtInt(rf.invited)} foot={`из них оплатили: ${fmtInt(rf.invited_paid)}`} />
          <Kpi title="Начислено бонусов" icon={Gift} value={fmtMoney(rf.bonuses)} foot={`${fmtInt(rf.bonuses_count)} начислений`} />
          <Kpi title="Выплачено" icon={Wallet} value={fmtMoney(rf.withdrawn)} foot={`${fmtInt(rf.withdrawn_count)} выводов`} />
          <Kpi title="Ждут вывода" icon={Clock} value={fmtMoney(rf.pending)} foot={`${fmtInt(rf.pending_count)} заявок · приглашающих ${fmtInt(rf.partners)}`} />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="tbl-wrap">
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)' }}><h4 className="h-sec">Топ приглашающих</h4></div>
            <div style={{ overflowX: 'auto' }}><table className="tbl" style={{ minWidth: 480 }}>
              <thead><tr><th>Пользователь</th><th>Пригласил</th><th>Оплатили</th><th style={{ textAlign: 'right' }}>Заработал</th></tr></thead>
              <tbody>
                {rf.top.length === 0 ? <tr className="empty-row"><td colSpan={4}>Пока никого</td></tr> : rf.top.map((r: any) => (
                  <tr key={r.id} className="click" onClick={() => onOpenUser(r.id)}>
                    <td style={{ fontWeight: 500 }}>{r.name}</td><td className="sub">{fmtInt(r.invited)}</td>
                    <td className="sub">{fmtInt(r.paid)}</td><td style={{ textAlign: 'right', fontWeight: 500 }}>{fmtMoney(r.earned)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
          <div className="tbl-wrap">
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)' }}><h4 className="h-sec">Рекламные ссылки</h4></div>
            <div style={{ overflowX: 'auto' }}><table className="tbl" style={{ minWidth: 480 }}>
              <thead><tr><th>Ссылка</th><th>Переходы</th><th>Новые</th><th>Оплатили</th><th style={{ textAlign: 'right' }}>Выручка</th></tr></thead>
              <tbody>
                {s.promo.links.length === 0 ? <tr className="empty-row"><td colSpan={5}>Ссылок нет</td></tr> : s.promo.links.map((l: any) => (
                  <tr key={l.code}>
                    <td style={{ fontWeight: 500 }}>{l.name}</td><td className="sub">{fmtInt(l.clicks)}</td><td className="sub">{fmtInt(l.new_users)}</td>
                    <td className="sub">{fmtInt(l.paid_users)}{l.new_users ? <span className="faint"> · {pctStr((100 * l.paid_users) / l.new_users)}</span> : null}</td>
                    <td style={{ textAlign: 'right', fontWeight: 500 }}>{fmtMoney(l.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        </div>
      </StatSection>

      <StatSection title="По месяцу регистрации" sub="Люди, пришедшие в каждом месяце: сколько взяли пробный, сколько оплатили и сколько денег принесли.">
        <div className="tbl-wrap"><div style={{ overflowX: 'auto' }}>
          <table className="tbl" style={{ minWidth: 720 }}>
            <thead><tr><th>Месяц</th><th>Пришли</th><th>Взяли пробный</th><th>Оплатили</th><th>Покупают повторно</th><th>Выручка</th><th style={{ textAlign: 'right' }}>На пользователя</th></tr></thead>
            <tbody>
              {s.cohorts.map((c: any) => (
                <tr key={c.label}>
                  <td style={{ fontWeight: 500 }}>{c.label}</td><td>{fmtInt(c.users)}</td>
                  <td className="sub">{pctStr(c.trial)}</td>
                  <td><span className="flex items-center gap-2"><span style={{ width: 60, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${c.paid || 0}%`, background: '#fff' }} /></span>{pctStr(c.paid)}</span></td>
                  <td className="sub">{pctStr(c.repeat)}</td>
                  <td>{fmtMoney(c.revenue)}</td><td style={{ textAlign: 'right', fontWeight: 500 }}>{fmtMoney(c.ltv)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>
      </StatSection>
    </div>
  );
};
