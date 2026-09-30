import React, { useCallback, useEffect, useState } from 'react';
import { Check, Play, Plug, PlugZap, Power, RefreshCw } from 'lucide-react';
import { PageHead, Spinner } from '../../components/ui';
import { CopyBtn, Err, HowTo, JobLog, Ok, Steps } from '../../components/Steps';
import { apiFetch, parseApiErr } from '../../lib/api';
import type { ToastType } from '../../lib/types';

type Status = {
  xbm_container: string; xbm_healthy: boolean; nginx_conf: boolean; nginx_container: string; connected: boolean | null;
  networks: string[]; containers: string[]; network: string; remnawave_url: string; sub_domain: string;
  conf?: string; container?: string;
};
type Info = { runner: boolean; xbm: { running: boolean }; defaults: Record<string, string> };
type JobRes = { status: 'queued' | 'running' | 'ok' | 'error'; log: string[]; result?: any; error?: string | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// действие через помощника на сервере, ждём результат
async function runJob(action: string, params: Record<string, string>, onLog: (l: string[]) => void): Promise<JobRes> {
  const { job } = await apiFetch(`/panel/xbm/setup/${action}`, { method: 'POST', body: JSON.stringify(params) });
  for (let i = 0; i < 600; i++) {
    await sleep(i < 5 ? 700 : 1500);
    const r: JobRes = await apiFetch(`/panel/xbm/setup/jobs/${job}`);
    onLog(r.log || []);
    if (r.status === 'ok' || r.status === 'error') return r;
  }
  return { status: 'error', log: [], error: 'Нет ответа от помощника на сервере' };
}

/** true, если xbm подключён к подписке (можно открывать настройку строк). */
export async function xbmIsReady(): Promise<{ ready: boolean; runner: boolean }> {
  const i: Info = await apiFetch('/panel/xbm/setup');
  if (!i.runner) return { ready: false, runner: false };
  const r = await runJob('status', {}, () => {});
  if (r.status !== 'ok') return { ready: false, runner: true };
  return { ready: !!r.result?.connected, runner: true };
}

export const XbmSettingsTab: React.FC<{
  onToast: (t: string, m: string, ty: ToastType) => void;
  /** после успешного подключения — перейти к настройке строк */
  onReady?: () => void;
  /** заголовок страницы (в балансировщике — «Балансировщик») */
  title?: string;
}> = ({ onToast, onReady, title = 'XBM' }) => {
  const [info, setInfo] = useState<Info | null>(null);
  const [st, setSt] = useState<Status | null>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [f, setF] = useState({ remnawave_url: '', sub_domain: '', network: '', conf: '', container: '' });
  const [rules, setRules] = useState('');
  const [rulesOk, setRulesOk] = useState(false);

  const refresh = useCallback(async () => {
    setErr('');
    try {
      const i: Info = await apiFetch('/panel/xbm/setup');
      setInfo(i);
      if (!i.runner) return;
      const r = await runJob('status', {}, () => {});
      if (r.status !== 'ok') { setErr(r.error || 'Не удалось получить состояние'); return; }
      const s: Status = r.result;
      setSt(s);
      setF((cur) => ({
        remnawave_url: cur.remnawave_url || s.remnawave_url || i.defaults.remnawave_url,
        sub_domain: cur.sub_domain || s.sub_domain || i.defaults.sub_domain,
        network: cur.network || s.network || i.defaults.network,
        conf: cur.conf || s.conf || i.defaults.conf,
        container: cur.container || s.container || i.defaults.container,
      }));
      setStep(s.connected ? 3 : s.xbm_healthy ? 1 : 0);
    } catch (e) { setErr(parseApiErr(e, 'Ошибка')); }
  }, []);
  useEffect(() => { void refresh(); apiFetch('/panel/xbm/response-rules').then((r) => setRules(r.text || '')).catch(() => {}); }, [refresh]);

  const act = async (action: string, params: Record<string, string>, next?: number, okMsg?: string) => {
    setBusy(action); setErr(''); setLog([]);
    try {
      const r = await runJob(action, params, setLog);
      if (r.status === 'ok') {
        if (okMsg) onToast(okMsg, '', 'success');
        if (next != null) setStep(next);
        const s = await runJob('status', {}, () => {});
        if (s.status === 'ok') setSt(s.result);
        if (action === 'xbm_connect' && onReady) onReady();
      } else setErr(r.error || 'Не получилось');
    } catch (e) { setErr(parseApiErr(e, 'Ошибка')); } finally { setBusy(''); }
  };

  const checkRules = async () => {
    setBusy('check'); setErr('');
    try { await apiFetch('/panel/xbm/check', { method: 'POST' }); setRulesOk(true); setStep(2); }
    catch (e) { setErr(parseApiErr(e, 'Не получилось')); } finally { setBusy(''); }
  };

  if (!info) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;

  if (!info.runner) {
    return (
      <div className="flex flex-col gap-4">
        <PageHead title={title} sub="Установка XBM" />
        <div className="card flex flex-col gap-3" style={{ padding: 20 }}>
          <div style={{ fontWeight: 600 }}>Нужен помощник на сервере</div>
          <HowTo items={[
            <>Подключитесь к серверу по SSH.</>,
            <>Выполните <span className="mono">cd /opt && sudo bash blinvpn/install.sh</span> и выберите «Обновить».</>,
            <>Вернитесь сюда и нажмите «Проверить».</>,
          ]} />
          <button className="btn solid" style={{ alignSelf: 'flex-start' }} onClick={() => void refresh()}><RefreshCw size={15} /> Проверить</button>
        </div>
      </div>
    );
  }

  const field = (k: keyof typeof f, label: string, ph?: string) => (
    <div><label className="field-label">{label}</label><input className="input" value={f[k]} placeholder={ph} onChange={(e) => setF({ ...f, [k]: e.target.value.trim() })} /></div>
  );
  const running = (a: string) => busy === a ? <Spinner size={15} /> : null;
  const containers = [...new Set([f.container, ...(st?.containers || [])])].filter(Boolean);

  return (
    <div className="flex flex-col gap-4">
      <PageHead title={title} sub="Установка XBM">
        <div className="flex items-center gap-2">
          <span className={`badge ${st?.xbm_healthy ? 'solid' : 'line'}`}>{st?.xbm_healthy ? (st.connected ? 'Работает' : 'Установлен') : 'Не установлен'}</span>
          <button className="icon-btn" disabled={!!busy} onClick={() => void refresh()} title="Обновить" aria-label="Обновить"><RefreshCw size={16} /></button>
        </div>
      </PageHead>

      <Steps current={step} steps={[
        {
          title: 'Установить XBM на сервер',
          done: !!st?.xbm_healthy && step > 0,
          body: <>
            <HowTo items={[
              <>Адрес Remnawave подставляется из .env (REMWAVE_PANEL_URL) — тот же, что при установке. Поправьте, если XBM ходит к панели иначе.</>,
              <>Укажите домен страницы подписки — тот, что в ссылке подписки у пользователей.</>,
              <>Нажмите «Установить». Сборка занимает пару минут.</>,
            ]} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {field('remnawave_url', 'Адрес Remnawave', 'https://panel.example.com:8443')}
              {field('sub_domain', 'Домен страницы подписки', 'sub.example.com')}
              <div><label className="field-label">Сеть Docker Remnawave</label>
                <select className="input" value={f.network} onChange={(e) => setF({ ...f, network: e.target.value })}>
                  {[...new Set([f.network, ...(st?.networks || [])])].filter(Boolean).map((n) => <option key={n} value={n}>{n}</option>)}
                </select></div>
            </div>
            <button className="btn solid" style={{ alignSelf: 'flex-start' }} disabled={!!busy || !f.remnawave_url || !f.sub_domain}
              onClick={() => void act('xbm_install', { remnawave_url: f.remnawave_url, sub_domain: f.sub_domain, network: f.network }, 1, 'XBM установлен')}>
              {running('xbm_install') || <Play size={15} />} {st?.xbm_healthy ? 'Переустановить' : 'Установить'}
            </button>
            {st?.xbm_healthy && !busy && <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setStep(1)}>Далее</button>}
          </>,
        },
        {
          title: 'Включить Xray JSON в Remnawave',
          done: rulesOk || !!st?.connected,
          body: <>
            <HowTo items={[
              <>Откройте панель Remnawave → <b>Subscription</b> → <b>Response Rules</b>.</>,
              <>Скопируйте текущие правила себе — на случай, если захотите вернуть.</>,
              <>Нажмите «Скопировать правила» ниже, вставьте их вместо старых и нажмите <b>Save</b>.</>,
              <>Вернитесь сюда и нажмите «Проверить».</>,
            ]} />
            <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
              {rules && <CopyBtn text={rules} label="Скопировать правила" />}
              <button className="btn solid" disabled={!!busy} onClick={() => void checkRules()}>{running('check')} Проверить</button>
              <button className="btn ghost" disabled={!!busy} onClick={() => setStep(0)}>Назад</button>
            </div>
          </>,
        },
        {
          title: 'Подключить XBM к подписке',
          done: !!st?.connected,
          body: <>
            <HowTo items={[
              <>Выберите контейнер nginx страницы подписки (не бота и не панели BlinVPN).</>,
              <>Проверьте путь к nginx.conf — по умолчанию как в установке Remnawave.</>,
              <>Нажмите «Подключить». Перед правкой делается резервная копия; если что-то пойдёт не так — всё вернётся само.</>,
            ]} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="field-label">Контейнер nginx</label>
                {containers.length > 0 ? (
                  <select className="input" value={f.container} onChange={(e) => setF({ ...f, container: e.target.value })}>
                    {containers.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                ) : (
                  <input className="input" value={f.container} placeholder="remnawave-nginx" onChange={(e) => setF({ ...f, container: e.target.value.trim() })} />
                )}
              </div>
              {field('conf', 'Файл nginx', '/opt/remnawave/nginx/nginx.conf')}
            </div>
            <div className="flex gap-2">
              <button className="btn solid" disabled={!!busy || !f.container} onClick={() => void act('xbm_connect', { sub_domain: f.sub_domain, conf: f.conf, container: f.container }, 3, 'XBM подключён')}>
                {running('xbm_connect') || <PlugZap size={15} />} Подключить
              </button>
              <button className="btn ghost" disabled={!!busy} onClick={() => setStep(1)}>Назад</button>
            </div>
          </>,
        },
        {
          title: 'Готово',
          body: <>
            <Ok>XBM работает. Можно настроить строки подписки для пользователей.</Ok>
            <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
              {onReady && (
                <button className="btn solid" onClick={onReady}><Check size={15} /> К настройке строк</button>
              )}
              <button className="btn" disabled={!!busy} onClick={() => { if (window.confirm('Отключить XBM от подписки? Пользователи снова получат обычную подписку.')) void act('xbm_disconnect', { conf: f.conf, container: f.container }, 2, 'Отключено'); }}>
                {running('xbm_disconnect') || <Plug size={15} />} Отключить от подписки
              </button>
              <button className="btn danger" disabled={!!busy} onClick={() => { if (window.confirm('Остановить XBM?')) void act('xbm_stop', {}, 0, 'XBM остановлен'); }}>
                {running('xbm_stop') || <Power size={15} />} Остановить
              </button>
            </div>
          </>,
        },
      ]} />

      {err && <Err>{err}</Err>}
      <JobLog lines={log} />
    </div>
  );
};
