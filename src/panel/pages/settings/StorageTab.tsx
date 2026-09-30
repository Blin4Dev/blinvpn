import React, { useEffect, useState } from 'react';
import { Database, PlugZap, Save } from 'lucide-react';
import { Spinner, Toggle } from '../../components/ui';
import { apiFetch, parseApiErr } from '../../lib/api';
import type { ToastType } from '../../lib/types';

type S3Cfg = {
  enabled: boolean; endpoint: string; region: string; bucket: string; access_key: string; has_secret: boolean;
  prefix: string; size_gb: number;
  storage?: { kind: 's3' | 'local'; used_bytes: number; cap_bytes: number; support_bytes: number; trigger_pct: number };
};

const gb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} ГБ` : `${Math.round(b / 1024 ** 2)} МБ`);

const F: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div><label className="field-label">{label}</label>{children}{hint && <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>{hint}</div>}</div>
);

/** Настройки → Хранилище: S3 (Timeweb Cloud) для вложений поддержки. */
export const StorageSettingsTab: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [cfg, setCfg] = useState<S3Cfg | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState('');
  const load = () => apiFetch('/panel/settings/s3').then(setCfg).catch((e) => onToast('Ошибка', parseApiErr(e, 'Не удалось загрузить'), 'error'));
  useEffect(() => { load(); }, []);
  if (!cfg) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  const set = (k: keyof S3Cfg, v: any) => setCfg({ ...cfg, [k]: v });
  const body = () => ({ enabled: cfg.enabled, endpoint: cfg.endpoint, region: cfg.region, bucket: cfg.bucket, access_key: cfg.access_key,
    secret_key: secret || undefined, prefix: cfg.prefix, size_gb: Number(cfg.size_gb) || 0 });
  const check = async () => {
    setBusy('check');
    try { await apiFetch('/panel/settings/s3/check', { method: 'POST', body: JSON.stringify(body()) }); onToast('Готово', 'Хранилище отвечает: запись, чтение и удаление работают', 'success'); }
    catch (e) { onToast('Не работает', parseApiErr(e, 'Не удалось подключиться'), 'error'); } finally { setBusy(''); }
  };
  const save = async () => {
    setBusy('save');
    try { const r = await apiFetch('/panel/settings/s3', { method: 'PUT', body: JSON.stringify(body()) }); setCfg(r); setSecret(''); onToast('Сохранено', r.enabled ? 'Новые вложения поддержки будут храниться в S3' : 'Вложения хранятся на сервере', 'success'); }
    catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось сохранить'), 'error'); } finally { setBusy(''); }
  };
  const st = cfg.storage;
  const pct = st && st.cap_bytes ? Math.min(100, (100 * st.used_bytes) / st.cap_bytes) : null;
  return (
    <div className="flex flex-col gap-4">
      <div className="card" style={{ padding: 20 }}>
        <div className="flex items-center justify-between gap-3" style={{ marginBottom: 6 }}>
          <div className="flex items-center gap-2"><Database size={18} /><span className="h-sec">Хранилище S3</span></div>
          <div className="flex items-center gap-2"><span className="sub" style={{ fontSize: 13 }}>{cfg.enabled ? 'Включено' : 'Выключено'}</span><Toggle on={cfg.enabled} onChange={() => set('enabled', !cfg.enabled)} /></div>
        </div>
        <div style={{ marginBottom: 16 }} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <F label="Адрес (endpoint)" hint="Timeweb Cloud: https://s3.twcstorage.ru"><input className="input" value={cfg.endpoint} onChange={(e) => set('endpoint', e.target.value)} /></F>
          <F label="Регион" hint="Timeweb Cloud: ru-1"><input className="input" value={cfg.region} onChange={(e) => set('region', e.target.value)} /></F>
          <F label="Бакет" hint="Имя бакета из панели Timeweb"><input className="input" value={cfg.bucket} onChange={(e) => set('bucket', e.target.value)} placeholder="a1b2c3d4-blinvpn" /></F>
          <F label="Папка в бакете"><input className="input" value={cfg.prefix} onChange={(e) => set('prefix', e.target.value)} /></F>
          <F label="Access Key"><input className="input" value={cfg.access_key} onChange={(e) => set('access_key', e.target.value)} autoComplete="off" /></F>
          <F label="Secret Key" hint={cfg.has_secret ? 'Сохранён. Оставьте пустым, чтобы не менять' : undefined}>
            <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={cfg.has_secret ? '••••••••••••' : ''} autoComplete="new-password" />
          </F>
          <F label="Размер хранилища, ГБ" hint="По тарифу бакета. Когда занято 90% — старые вложения удаляются автоматически. 0 — без ограничения">
            <input className="input" type="number" min={0} step="1" value={cfg.size_gb || ''} onChange={(e) => set('size_gb', e.target.value)} placeholder="10" />
          </F>
        </div>
        <div className="flex gap-2" style={{ marginTop: 18, flexWrap: 'wrap' }}>
          <button className="btn" disabled={!!busy} onClick={check}>{busy === 'check' ? <Spinner size={15} /> : <PlugZap size={15} />} Проверить подключение</button>
          <button className="btn solid" disabled={!!busy} onClick={save}>{busy === 'save' ? <Spinner size={15} /> : <Save size={15} />} Сохранить</button>
        </div>
      </div>

      {st && (
        <div className="card" style={{ padding: 20 }}>
          <div className="h-sec" style={{ marginBottom: 10 }}>Сейчас вложения хранятся {st.kind === 's3' ? 'в S3' : 'на сервере'}</div>
          {pct != null && (
            <>
              <div className="flex justify-between sub" style={{ fontSize: 13, marginBottom: 6 }}>
                <span>Занято {gb(st.used_bytes)} из {gb(st.cap_bytes)}{st.kind === 'local' ? ' (весь диск сервера)' : ''}</span><span>{pct.toFixed(0)}%</span>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: pct >= st.trigger_pct ? 'var(--danger)' : '#fff', opacity: 0.85 }} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
