import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { PageHead, Panel, Row, Spinner } from '../../components/ui';
import { CopyBtn, Err, HowTo } from '../../components/Steps';
import { apiFetch, parseApiErr } from '../../lib/api';
import type { ToastType } from '../../lib/types';

type Running = { running?: boolean } | null | undefined;
type EdgeStatus = {
  split: boolean; ok?: boolean; error?: string; warning?: string;
  version?: string; panel_version?: string; protocol?: number; public_ip?: string; uptime?: number;
  nginx?: Running; xbm?: Running; subpage?: Running; miniapp?: Running;
  domains?: { app?: string; sub?: string; hook?: string };
  domains_expected?: { app?: string; sub?: string; hook?: string };
  problems?: string[];
  hook_urls?: Record<string, string>;
};

const yes = (v: unknown) => (v ? <span style={{ color: '#34d399' }}>работает</span> : <span style={{ color: 'var(--danger)' }}>нет</span>);
const IN_INVOICE = new Set(['lava', 'heleket', '2328']);

// разделённая установка: состояние edge-сервера (то, что видят пользователи)
export const ServersSettingsTab: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [st, setSt] = useState<EdgeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setBusy(true); setErr('');
    try { setSt(await apiFetch('/panel/edge')); } catch (e) { setErr(parseApiErr(e, 'Не удалось получить состояние')); onToast('Ошибка', 'Не удалось получить состояние серверов', 'error'); }
    finally { setBusy(false); }
  }, [onToast]);
  useEffect(() => { void load(); }, [load]);

  if (!st && !err) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;

  const refresh = (
    <button className="icon-btn" disabled={busy} onClick={() => void load()} title="Обновить" aria-label="Обновить">
      {busy ? <Spinner size={16} /> : <RefreshCw size={16} />}
    </button>
  );

  if (st && !st.split) {
    return (
      <div className="flex flex-col gap-4">
        <PageHead title="Серверы" sub="Установка на одном сервере">{refresh}</PageHead>
        <div className="card" style={{ padding: 20, fontSize: 14 }}>Панель и мини-приложение работают на одном сервере.</div>
      </div>
    );
  }

  const d = st?.domains || {};
  const want = st?.domains_expected || {};
  const mismatch = st?.ok && (d.app !== want.app || d.sub !== want.sub || d.hook !== want.hook);

  return (
    <div className="flex flex-col gap-4">
      <PageHead title="Серверы" sub="Панель и edge (мини-приложение, подписка, вебхуки)">{refresh}</PageHead>
      {err && <Err>{err}</Err>}
      {st && (
        <>
          <Panel title="Edge-сервер">
            {st.ok ? (
              <>
                <Row k="Связь по туннелю" v={<span style={{ color: '#34d399' }}>есть</span>} />
                <Row k="IP edge (его видят пользователи)" v={<span className="mono">{st.public_ip || '—'}</span>} />
                <Row k="Версия edge / панели" v={`${st.version || '?'} / ${st.panel_version || '?'}`} />
                <Row k="nginx" v={yes(st.nginx?.running)} />
                <Row k="Мини-приложение" v={yes(st.miniapp?.running)} />
                <Row k="XBM (подписка для приложений)" v={yes(st.xbm?.running)} />
                <Row k="Страница подписки" v={yes(st.subpage?.running)} />
              </>
            ) : (
              <Err>Edge недоступен: {st.error || 'нет ответа'}. VPN-подключения пользователей продолжают работать; мини-приложение и обновление подписки — нет.</Err>
            )}
            {st.warning && <div style={{ marginTop: 12 }}><Err>{st.warning}</Err></div>}
          </Panel>

          <Panel title="Домены">
            <Row k="Мини-приложение" v={<span className="mono">{want.app || '—'}</span>} />
            <Row k="Подписка" v={<span className="mono">{want.sub || '—'}</span>} />
            <Row k="Вебхуки платёжек" v={<span className="mono">{want.hook || '—'}</span>} />
            {mismatch && <div style={{ marginTop: 12 }}><Err>На edge другие домены ({d.app}, {d.sub}, {d.hook}). Выполните на сервере панели: <span className="mono">sudo blinvpn domains</span></Err></div>}
            {(st.problems || []).length > 0 && (
              <div style={{ marginTop: 12 }}><Err>{(st.problems || []).join('; ')}</Err></div>
            )}
          </Panel>

          {st.hook_urls && Object.keys(st.hook_urls).length > 0 && (
            <Panel title="Адреса уведомлений платёжек">
              {Object.entries(st.hook_urls).map(([k, url]) => (
                <div key={k} className="flex items-center justify-between gap-3" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)', fontSize: 14, flexWrap: 'wrap' }}>
                  <span className="muted" style={{ minWidth: 90 }}>{k}</span>
                  <span className="mono" style={{ flex: '1 1 14rem', wordBreak: 'break-all' }}>{url}</span>
                  {IN_INVOICE.has(k) ? <span className="faint" style={{ fontSize: 12 }}>передаётся в счёте сам</span> : <CopyBtn text={url} />}
                </div>
              ))}
            </Panel>
          )}

          <Panel title="Переезд и смена адресов">
            <HowTo items={[
              <>Заблокировали домен мини-аппа, подписки или вебхуков — купите новый, направьте A-запись на IP edge и выполните на сервере панели <span className="mono">sudo blinvpn domains</span>: сертификаты и nginx на edge обновятся сами.</>,
              <>Edge сменил IP — обновите A-записи доменов edge и выполните <span className="mono">sudo blinvpn edge-endpoint НОВЫЙ_IP</span>.</>,
              <>Edge переезжает на новый сервер — на панели <span className="mono">sudo blinvpn pair</span>, на новом сервере <span className="mono">sudo bash install.sh</span> → «Edge».</>,
              <>Панель сменила IP — достаточно обновить A-запись домена панели: панель сама подключается к edge.</>,
            ]} />
          </Panel>
        </>
      )}
    </div>
  );
};
