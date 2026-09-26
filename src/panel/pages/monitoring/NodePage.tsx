import React, { useState, useEffect } from 'react';
import {
  Settings, CreditCard, Activity, Database, Plus, Trash2, AlertTriangle, RefreshCw, ArrowLeft, ExternalLink, Cpu, HardDrive, Gauge, MemoryStick, Play, Square, KeyRound, Network, ShieldCheck,
} from 'lucide-react';
import { Legend, LineChart } from '../../components/charts';
import { DCard, Modal, Segmented, Spinner } from '../../components/ui';
import { apiFetch, parseApiErr } from '../../lib/api';
import { fmtDateTime, relTime } from '../../lib/format';
import type { ToastType } from '../../lib/types';
import { InstallSteps, MonEditModal, MonPayModal } from './NodeModals';
import { MON_COLORS, StatusDot, fmtBytes, fmtDur, fmtMbit, fmtRate, fmtUptime, pct } from './shared';
import type { MonDetail } from './shared';

export function useSeries(nodeId: number, metric: string, range: string, tick: number) {
  const [data, setData] = useState<{ points: any[][] } | null>(null);
  useEffect(() => {
    let alive = true;
    apiFetch(`/panel/monitoring/nodes/${nodeId}/series?metric=${metric}&range=${range}`).then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setData({ points: [] }); });
    return () => { alive = false; };
  }, [nodeId, metric, range, tick]);
  return data?.points || null;
}

export const MetricCard: React.FC<{ title: string; icon: React.ElementType; now: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }> =
  ({ title, icon: Icon, now, sub, right, children }) => (
    <div className="card" style={{ padding: 18 }}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2 sub" style={{ fontSize: 13 }}><Icon size={15} className="faint" />{title}</div>
          <div className="flex items-baseline gap-2 mt-1" style={{ flexWrap: 'wrap' }}>
            <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em' }}>{now}</span>
            {sub && <span className="sub" style={{ fontSize: 13 }}>{sub}</span>}
          </div>
        </div>
        {right}
      </div>
      {children}
    </div>
  );

// Полоса проверок VLESS: не больше 90 делений, деление красное, если в нём был хоть один сбой
export const vlessBuckets = (pts: any[][]) => {
  const size = Math.max(1, Math.ceil(pts.length / 90));
  const out: { t: number; n: number; fail: number }[] = [];
  for (let i = 0; i < pts.length; i += size) {
    const chunk = pts.slice(i, i + size);
    out.push({ t: chunk[0][0], n: chunk.length, fail: chunk.filter((p) => !p[1]).length });
  }
  return out;
};

export const INCIDENT_ICON: Record<string, string> = { critical: '🔴', warning: '🟠', info: '💳' };

export const MonNodePage: React.FC<{ nodeId: number; onBack: () => void; onToast: (t: string, m: string, ty: ToastType) => void }> = ({ nodeId, onBack, onToast }) => {
  const [d, setD] = useState<MonDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [range, setRange] = useState<'6h' | '24h' | '7d'>('24h');
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState('');
  const [modal, setModal] = useState<'' | 'edit' | 'pay' | 'key'>('');
  const [newSecret, setNewSecret] = useState('');
  const load = async () => {
    try { setD(await apiFetch(`/panel/monitoring/nodes/${nodeId}`)); }
    catch (e: any) { if (String(e?.message || '').includes('не найдена')) setMissing(true); }
  };
  useEffect(() => { load(); const t = setInterval(() => { load(); setTick((x) => x + 1); }, 60000); return () => clearInterval(t); }, [nodeId]);

  const cpu = useSeries(nodeId, 'cpu', range, tick);
  const ram = useSeries(nodeId, 'ram', range, tick);
  const disk = useSeries(nodeId, 'disk', range, tick);
  const io = useSeries(nodeId, 'io', range, tick);
  const net = useSeries(nodeId, 'net', range, tick);
  const ping = useSeries(nodeId, 'ping', range, tick);
  const speed = useSeries(nodeId, 'speed', range === '6h' ? '24h' : range, tick);
  const vless = useSeries(nodeId, 'vless', range, tick);

  const act = async (what: string, fn: () => Promise<any>, ok?: string) => {
    setBusy(what);
    try { const r = await fn(); if (ok) onToast('Готово', ok, 'success'); await load(); setTick((x) => x + 1); return r; }
    catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось выполнить действие'), 'error'); }
    finally { setBusy(''); }
  };

  if (missing) return <div className="flex flex-col gap-4"><button className="btn" style={{ alignSelf: 'flex-start' }} onClick={onBack}><ArrowLeft size={16} /> К нодам</button><div className="muted">Нода не найдена.</div></div>;
  if (!d) return <div style={{ padding: 60, display: "flex", justifyContent: "center" }}><Spinner size={22} /></div>;

  const L = d.live || {};
  const cpuNow = L.cpu as number | null;
  const ramP = pct(L.ram_used, L.ram_total); const diskP = pct(L.disk_used, L.disk_total);
  const col = (p: number | null) => (p == null ? undefined : p >= 90 ? 'var(--danger)' : p >= 80 ? '#fb923c' : undefined);
  const t = (pts: any[][] | null) => (pts || []).map((p) => p[0]);
  const payDue = d.payment.date ? new Date(d.payment.date) : null;
  const payLeftH = payDue ? (payDue.getTime() - Date.now()) / 3600000 : null;
  const openInc = d.incidents.filter((i) => !i.resolved_at);

  return (
    <div className="flex flex-col gap-5">
      {modal === 'edit' && <MonEditModal node={d} onClose={() => setModal('')} onSaved={() => { setModal(''); load(); }} onToast={onToast} />}
      {modal === 'pay' && <MonPayModal node={d} onClose={() => setModal('')} onSaved={() => { setModal(''); load(); }} onToast={onToast} />}
      {modal === 'key' && (
        <Modal onClose={() => { setModal(''); setNewSecret(''); load(); }} title="Новый ключ агента" icon={KeyRound} width={620}
          footer={<><button className="btn" onClick={() => { setModal(''); setNewSecret(''); load(); }}>Закрыть</button>
            <button className="btn solid" disabled={!!busy} onClick={() => act('start', () => apiFetch(`/panel/monitoring/nodes/${d.id}/start`, { method: 'POST' }), 'Мониторинг запущен').then((r) => { if (r) { setModal(''); setNewSecret(''); } })}><Play size={15} /> Запустить</button></>}>
          <div className="sub" style={{ marginBottom: 14, fontSize: 13 }}>Старый ключ больше не работает. На сервере выполните <span style={{ fontVariantNumeric: 'tabular-nums' }}>sudo bash node.sh set-key</span> и вставьте новый ключ (или переустановите агент командой ниже).</div>
          <InstallSteps secret={newSecret} port={d.port} onToast={onToast} />
        </Modal>
      )}

      <div className="flex items-center justify-between gap-3" style={{ flexWrap: 'wrap' }}>
        <button className="btn" onClick={onBack}><ArrowLeft size={16} /> К нодам</button>
        <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
          {d.enabled
            ? <button className="btn" disabled={!!busy} onClick={() => act('stop', () => apiFetch(`/panel/monitoring/nodes/${d.id}/stop`, { method: 'POST' }), 'Мониторинг остановлен')}><Square size={14} /> Остановить</button>
            : <button className="btn solid" disabled={!!busy} onClick={() => act('start', () => apiFetch(`/panel/monitoring/nodes/${d.id}/start`, { method: 'POST' }), 'Агент на связи, мониторинг запущен')}>{busy === 'start' ? <Spinner size={15} /> : <Play size={14} />} Запустить</button>}
          <button className="btn" onClick={() => setModal('edit')}><Settings size={15} /> Настройки</button>
          <button className="btn" disabled={!!busy} onClick={() => { if (window.confirm('Перевыпустить ключ? Старый ключ перестанет работать, агенту нужно будет задать новый.')) act('key', () => apiFetch(`/panel/monitoring/nodes/${d.id}/rotate-secret`, { method: 'POST' })).then((r) => { if (r?.secret) { setNewSecret(r.secret); setModal('key'); } }); }}><KeyRound size={15} /> Новый ключ</button>
          <button className="btn danger" disabled={!!busy} onClick={() => { if (window.confirm(`Удалить ноду «${d.name}» и всю её историю?`)) act('del', () => apiFetch(`/panel/monitoring/nodes/${d.id}`, { method: 'DELETE' }), 'Нода удалена').then(() => onBack()); }}><Trash2 size={15} /> Удалить</button>
        </div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <div className="flex items-center gap-3" style={{ flexWrap: 'wrap' }}>
          <StatusDot s={d.status} size={14} />
          <span className="h-sec" style={{ fontSize: 20 }}>{d.name}</span>
          <span className="badge" style={{ background: `${MON_COLORS[d.status]}22`, color: MON_COLORS[d.status], borderColor: `${MON_COLORS[d.status]}55` }}>{d.status_label}</span>
          {openInc.length > 0 && <span className="badge danger">{openInc.length} {openInc.length === 1 ? 'инцидент' : 'инцидента'}</span>}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4" style={{ marginTop: 16 }}>
          <div><div className="sub" style={{ fontSize: 12 }}>IP / порт агента</div><div style={{ marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{d.ip}:{d.port}</div></div>
          <div><div className="sub" style={{ fontSize: 12 }}>Аптайм сервера</div><div style={{ marginTop: 2 }}>{fmtUptime(d.uptime)}</div></div>
          <div><div className="sub" style={{ fontSize: 12 }}>Агент</div><div style={{ marginTop: 2 }}>{d.agent_ok ? <>на связи · {relTime(d.last_seen)}</> : d.last_seen ? <span style={{ color: 'var(--danger)' }}>нет связи с {fmtDateTime(d.last_seen).slice(0, 16)}</span> : <span className="faint">ещё не подключался</span>}</div></div>
          <div><div className="sub" style={{ fontSize: 12 }}>Доступность 24 ч / 7 д</div><div style={{ marginTop: 2 }}>{d.ping.uptime_24h != null ? `${d.ping.uptime_24h}%` : '—'} / {d.ping.uptime_7d != null ? `${d.ping.uptime_7d}%` : '—'}</div></div>
        </div>
        {!d.enabled && <div className="inset sub" style={{ marginTop: 14, padding: 12, fontSize: 13 }}>Мониторинг не запущен. Установите агент на сервер и нажмите «Запустить».</div>}
        {d.enabled && d.last_error && !d.agent_ok && <div className="badge danger" style={{ marginTop: 14, width: '100%', padding: '10px 12px', justifyContent: 'flex-start', whiteSpace: 'normal' }}>{d.last_error}</div>}
      </div>

      {!d.last_seen ? null : <>
      <div className="flex items-center justify-between gap-3">
        <span className="h-sec">Нагрузка</span>
        <Segmented value={range} onChange={setRange} options={[{ value: '6h', label: '6 ч' }, { value: '24h', label: '24 ч' }, { value: '7d', label: '7 дней' }]} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <MetricCard title="Процессор" icon={Cpu} now={<span style={{ color: col(cpuNow) }}>{cpuNow != null ? `${cpuNow.toFixed(0)}%` : '—'}</span>} sub={d.cores ? `из ${d.cores} ${d.cores === 1 ? 'ядра' : 'ядер'} · load ${L.load1 ?? '—'}` : undefined}
          right={<Legend items={[{ name: 'среднее', color: '#fff' }, { name: 'пик', color: 'rgba(255,255,255,0.35)' }]} />}>
          <LineChart range={range} times={t(cpu)} yMax={100} format={(v) => `${v.toFixed(0)}%`}
            series={[{ name: 'пик', color: 'rgba(255,255,255,0.35)', values: (cpu || []).map((p) => p[2]), dashed: true }, { name: 'среднее', color: '#fff', values: (cpu || []).map((p) => p[1]) }]} />
        </MetricCard>
        <MetricCard title="Оперативная память" icon={MemoryStick} now={<span style={{ color: col(ramP) }}>{fmtBytes(L.ram_used)}</span>} sub={`из ${fmtBytes(L.ram_total)}${ramP != null ? ` · ${ramP.toFixed(0)}%` : ''}${L.swap_total ? ` · swap ${fmtBytes(L.swap_used)}` : ''}`}>
          <LineChart range={range} times={t(ram)} yMax={100} format={(v) => `${v.toFixed(0)}%`}
            series={[{ name: 'занято', color: '#fff', values: (ram || []).map((p) => (p[3] ? (100 * p[1]) / p[3] : null)) }]} />
        </MetricCard>
        <MetricCard title="Диск" icon={HardDrive} now={<span style={{ color: col(diskP) }}>{fmtBytes(L.disk_used)}</span>} sub={`из ${fmtBytes(L.disk_total)}${diskP != null ? ` · ${diskP.toFixed(0)}%` : ''}`}>
          <LineChart range={range} times={t(disk)} yMax={100} format={(v) => `${v.toFixed(1)}%`}
            series={[{ name: 'заполнено', color: '#fff', values: (disk || []).map((p) => (p[3] ? (100 * p[1]) / p[3] : null)) }]} />
        </MetricCard>
        <MetricCard title="Нагрузка на диск" icon={Database} now={fmtRate((L.disk_read_bps || 0) + (L.disk_write_bps || 0))} sub={`чтение ${fmtRate(L.disk_read_bps)} · запись ${fmtRate(L.disk_write_bps)}`}
          right={<Legend items={[{ name: 'чтение', color: '#fff' }, { name: 'запись', color: '#fb923c' }]} />}>
          <LineChart range={range} times={t(io)} format={(v) => fmtRate(v)}
            series={[{ name: 'чтение', color: '#fff', values: (io || []).map((p) => p[1]) }, { name: 'запись', color: '#fb923c', values: (io || []).map((p) => p[2]) }]} />
        </MetricCard>
        <MetricCard title="Сеть" icon={Network} now={fmtMbit(((L.net_rx_bps || 0) + (L.net_tx_bps || 0)) * 8 / 1e6)} sub={`вход ${fmtMbit((L.net_rx_bps || 0) * 8 / 1e6)} · выход ${fmtMbit((L.net_tx_bps || 0) * 8 / 1e6)}`}
          right={<Legend items={[{ name: 'вход', color: '#fff' }, { name: 'выход', color: '#60a5fa' }]} />}>
          <LineChart range={range} times={t(net)} format={(v) => fmtMbit(v)}
            series={[{ name: 'вход', color: '#fff', values: (net || []).map((p) => (p[1] != null ? p[1] * 8 / 1e6 : null)) }, { name: 'выход', color: '#60a5fa', values: (net || []).map((p) => (p[2] != null ? p[2] * 8 / 1e6 : null)) }]} />
        </MetricCard>
        <MetricCard title="Доступность" icon={Activity}
          now={d.ping.last ? (d.ping.last.lost >= d.ping.last.sent ? <span style={{ color: 'var(--danger)' }}>нет ответа</span> : `${d.ping.last.rtt_ms ?? '—'} мс`) : '—'}
          sub={d.ping.last ? `потери ${Math.round((100 * d.ping.last.lost) / Math.max(1, d.ping.last.sent))}% · проверка каждую минуту` : 'проверка каждую минуту'}
          right={<Legend items={[{ name: 'задержка', color: '#fff' }, { name: 'потери', color: '#ff6b6b', bar: true }]} />}>
          <LineChart range={range} times={t(ping)} format={(v) => `${v.toFixed(0)} мс`}
            series={[{ name: 'задержка', color: '#fff', values: (ping || []).map((p) => p[1]) }]}
            bars={{ name: 'потери', color: '#ff6b6b', values: (ping || []).map((p) => (p[2] > 0 ? p[2] : null)), format: (v) => `${v.toFixed(0)}%` }} />
        </MetricCard>
        <MetricCard title="Скорость интернета" icon={Gauge}
          now={d.last_speed ? (d.last_speed.ok ? `↓ ${fmtMbit(d.last_speed.down)}` : <span style={{ color: 'var(--danger)' }}>ошибка замера</span>) : '—'}
          sub={d.last_speed ? (d.last_speed.ok ? `↑ ${fmtMbit(d.last_speed.up)} · пинг ${d.last_speed.ping_ms ?? '—'} мс · ${relTime(new Date(d.last_speed.ts * 1000).toISOString())}` : relTime(new Date(d.last_speed.ts * 1000).toISOString())) : 'раз в 15 минут'}
          right={<button className="btn sm" disabled={!d.enabled || !!busy || d.speed_running} onClick={() => act('speed', () => apiFetch(`/panel/monitoring/nodes/${d.id}/speedtest`, { method: 'POST' }), 'Замер запущен — результат появится через ~30 секунд')}>
            {d.speed_running || busy === 'speed' ? <Spinner size={14} /> : <Gauge size={14} />} {d.speed_running ? 'Идёт замер…' : 'Замерить'}</button>}>
          <LineChart range={range === '6h' ? '24h' : range} times={t(speed)} format={(v) => fmtMbit(v)}
            series={[{ name: 'загрузка', color: '#fff', values: (speed || []).map((p) => p[1]) }, { name: 'отдача', color: '#34d399', values: (speed || []).map((p) => p[2]) }]} />
          <div style={{ marginTop: 8 }}><Legend items={[{ name: 'загрузка', color: '#fff' }, { name: 'отдача', color: '#34d399' }]} /></div>
        </MetricCard>
        <MetricCard title="VLESS" icon={ShieldCheck}
          now={!d.vless.configured ? <span className="faint">не задан</span> : d.vless.ok == null ? <span className="faint">{d.vless.error ? 'не проверяется' : 'ждёт проверки'}</span> : d.vless.ok ? <span style={{ color: MON_COLORS.green }}>подключается</span> : <span style={{ color: 'var(--danger)' }}>не подключается</span>}
          sub={d.vless.configured ? `${d.vless.info?.net || ''}/${d.vless.info?.sec || ''} · ${d.vless.info?.host}:${d.vless.info?.port}${d.vless.uptime_24h != null ? ` · ${d.vless.uptime_24h}% за 24 ч` : ''}` : undefined}
          right={d.vless.configured
            ? <button className="btn sm" disabled={!!busy} onClick={() => act('vless', () => apiFetch(`/panel/monitoring/nodes/${d.id}/vless-check`, { method: 'POST' }), 'Проверка выполнена')}>{busy === 'vless' ? <Spinner size={14} /> : <RefreshCw size={14} />} Проверить</button>
            : <button className="btn sm" onClick={() => setModal('edit')}><Plus size={14} /> Добавить ключ</button>}>
          {d.vless.configured ? (
            <>
              <div className="flex" style={{ gap: 2, height: 28, alignItems: 'stretch', overflow: 'hidden' }}>
                {(vless || []).length === 0 ? <div className="sub" style={{ fontSize: 13 }}>Проверок за период ещё не было</div> : vlessBuckets(vless || []).map((g, i) => (
                  <span key={i} title={`${fmtDateTime(new Date(g.t * 1000).toISOString()).slice(0, 16)} — ${g.fail ? `сбоев: ${g.fail} из ${g.n}` : 'все проверки успешны'}`}
                    style={{ flex: 1, minWidth: 0, borderRadius: 2, background: g.fail ? MON_COLORS.red : MON_COLORS.green, opacity: g.fail ? 1 : 0.7 }} />
                ))}
              </div>
              {d.vless.error && !d.vless.ok && <div className="sub" style={{ fontSize: 12, marginTop: 8, color: d.vless.ok == null ? undefined : 'var(--danger)' }}>{d.vless.error}</div>}
              <div className="sub" style={{ fontSize: 12, marginTop: 8 }}>Проверка раз в 5 минут{d.vless.checked_at ? ` · последняя ${relTime(d.vless.checked_at)}` : ''}</div>
            </>
          ) : <div className="sub" style={{ fontSize: 13 }}>Привяжите VLESS-ключ — панель будет раз в 5 минут подключаться через него и сообщит, если сервер перестанет пускать клиентов.</div>}
        </MetricCard>
      </div>
      </>}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2">
          <DCard title="Инциденты" icon={AlertTriangle} actions={<span className="sub" style={{ fontSize: 12 }}>{d.incidents.length ? `последние ${d.incidents.length}` : ''}</span>}>
            {d.incidents.length === 0 ? <div className="sub">Инцидентов не было.</div> : (
              <div className="flex flex-col gap-1" style={{ maxHeight: 420, overflowY: 'auto' }}>
                {d.incidents.map((i) => (
                  <div key={i.id} className="inset flex items-start justify-between gap-3" style={{ padding: '10px 12px', opacity: i.resolved_at && i.severity !== 'info' ? 0.75 : 1 }}>
                    <span className="flex items-start gap-2" style={{ minWidth: 0 }}>
                      <span>{INCIDENT_ICON[i.severity] || '•'}</span>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ fontWeight: 500 }}>{i.title}</span>
                        {i.details && <span className="sub" style={{ display: 'block', fontSize: 12 }}>{i.details}</span>}
                      </span>
                    </span>
                    <span className="sub" style={{ fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {fmtDateTime(i.started_at).slice(0, 16)}<br />
                      {i.severity === 'info' ? '' : i.resolved_at ? `длилось ${fmtDur(i.started_at, i.resolved_at)}` : <span style={{ color: 'var(--danger)' }}>идёт {fmtDur(i.started_at)}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </DCard>
        </div>
        <DCard title="Оплата сервера" icon={CreditCard} actions={<button className="btn sm" onClick={() => setModal('pay')}>{d.payment.date ? <><RefreshCw size={14} /> Продлить</> : <><Plus size={14} /> Указать</>}</button>}>
          {d.payment.date ? (
            <div className="flex flex-col gap-2">
              <div style={{ fontSize: 22, fontWeight: 600, color: payLeftH != null && payLeftH < 24 ? 'var(--danger)' : undefined }}>{fmtDateTime(d.payment.date).slice(0, 16)}</div>
              <div className="sub" style={{ fontSize: 13 }}>{payLeftH == null ? '' : payLeftH < 0 ? 'срок оплаты прошёл — продлите дату' : payLeftH < 48 ? `осталось ${Math.max(1, Math.round(payLeftH))} ч` : `осталось ${Math.round(payLeftH / 24)} дн.`}</div>
              {d.payment.url && <a className="btn sm" href={d.payment.url} target="_blank" rel="noreferrer" style={{ alignSelf: 'flex-start' }}><ExternalLink size={14} /> Оплатить</a>}
              <div className="sub" style={{ fontSize: 12 }}>Напоминания: за 24 ч, за 8 ч и в момент оплаты.</div>
            </div>
          ) : <div className="sub" style={{ fontSize: 13 }}>Укажите дату следующей оплаты — напоминания придут в топик «Инциденты».</div>}
        </DCard>
      </div>
    </div>
  );
};
