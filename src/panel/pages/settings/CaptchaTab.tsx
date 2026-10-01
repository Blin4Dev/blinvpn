import React, { useEffect, useState } from 'react';
import { Save, Shield } from 'lucide-react';
import { Spinner, Toggle } from '../../components/ui';
import { apiFetch, parseApiErr } from '../../lib/api';
import type { ToastType } from '../../lib/types';

type Cfg = {
  enabled: boolean;
  mode: 'auto' | 'yandex' | 'turnstile';
  yandex_site_key: string;
  turnstile_site_key: string;
  has_yandex_secret: boolean;
  has_turnstile_secret: boolean;
};

const F: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div><label className="field-label">{label}</label>{children}{hint && <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>{hint}</div>}</div>
);

const MODES: { id: Cfg['mode']; label: string; hint: string }[] = [
  { id: 'auto', label: 'Авто', hint: 'Россия → Яндекс SmartCaptcha, остальные → Cloudflare Turnstile' },
  { id: 'yandex', label: 'Только Яндекс', hint: 'SmartCaptcha для всех' },
  { id: 'turnstile', label: 'Только Cloudflare', hint: 'Turnstile для всех' },
];

// капча на странице входа мини-приложения (необязательно)
export const CaptchaSettingsTab: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [yandexSecret, setYandexSecret] = useState('');
  const [turnstileSecret, setTurnstileSecret] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => apiFetch('/panel/settings/captcha').then(setCfg).catch((e) => onToast('Ошибка', parseApiErr(e, 'Не удалось загрузить'), 'error'));
  useEffect(() => { load(); }, []);
  if (!cfg) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;

  const set = <K extends keyof Cfg>(k: K, v: Cfg[K]) => setCfg({ ...cfg, [k]: v });
  const save = async () => {
    setBusy(true);
    try {
      const r = await apiFetch('/panel/settings/captcha', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: cfg.enabled,
          mode: cfg.mode,
          yandex_site_key: cfg.yandex_site_key,
          turnstile_site_key: cfg.turnstile_site_key,
          yandex_secret: yandexSecret || undefined,
          turnstile_secret: turnstileSecret || undefined,
        }),
      });
      setCfg(r);
      setYandexSecret('');
      setTurnstileSecret('');
      onToast('Сохранено', r.enabled ? 'Капча включена на входе в мини-приложение' : 'Капча выключена', 'success');
    } catch (e) {
      onToast('Ошибка', parseApiErr(e, 'Не удалось сохранить'), 'error');
    } finally { setBusy(false); }
  };

  const showYandex = cfg.mode === 'auto' || cfg.mode === 'yandex';
  const showTurnstile = cfg.mode === 'auto' || cfg.mode === 'turnstile';

  return (
    <div className="flex flex-col gap-4">
      <div className="card" style={{ padding: 20 }}>
        <div className="flex items-center justify-between gap-3" style={{ marginBottom: 6 }}>
          <div className="flex items-center gap-2"><Shield size={18} /><span className="h-sec">Капча на входе</span></div>
          <div className="flex items-center gap-2">
            <span className="sub" style={{ fontSize: 13 }}>{cfg.enabled ? 'Включено' : 'Выключено'}</span>
            <Toggle on={cfg.enabled} onChange={() => set('enabled', !cfg.enabled)} />
          </div>
        </div>
        <div className="sub" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 16 }}>
          Показывается на веб-входе мини-приложения перед «Получить код» / «Войти» и при входе через Telegram.
          В самом Telegram Mini App капча не нужна. Можно оставить выключенной.
        </div>

        <div style={{ marginBottom: 16 }}>
          <label className="field-label">Режим</label>
          <div className="flex flex-col gap-2">
            {MODES.map((m) => (
              <label key={m.id} className="flex items-start gap-3" style={{ cursor: 'pointer', padding: '10px 12px', borderRadius: 10, background: cfg.mode === m.id ? 'rgba(255,255,255,0.06)' : 'transparent', border: `1px solid ${cfg.mode === m.id ? 'var(--border)' : 'transparent'}` }}>
                <input type="radio" name="captcha-mode" checked={cfg.mode === m.id} onChange={() => set('mode', m.id)} style={{ marginTop: 3, accentColor: 'var(--accent)' }} />
                <span>
                  <span style={{ display: 'block', fontWeight: 600, fontSize: 14 }}>{m.label}</span>
                  <span className="faint" style={{ fontSize: 12 }}>{m.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {showYandex && (
          <div style={{ marginBottom: 18 }}>
            <div className="h-sec" style={{ fontSize: 14, marginBottom: 10 }}>Яндекс SmartCaptcha</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <F label="Client Key (site key)" hint="Из консоли Yandex Cloud → SmartCaptcha">
                <input className="input" value={cfg.yandex_site_key} onChange={(e) => set('yandex_site_key', e.target.value)} autoComplete="off" />
              </F>
              <F label="Server Key" hint={cfg.has_yandex_secret ? 'Сохранён. Оставьте пустым, чтобы не менять' : undefined}>
                <input className="input" type="password" value={yandexSecret} onChange={(e) => setYandexSecret(e.target.value)} placeholder={cfg.has_yandex_secret ? '••••••••••••' : ''} autoComplete="new-password" />
              </F>
            </div>
          </div>
        )}

        {showTurnstile && (
          <div style={{ marginBottom: 18 }}>
            <div className="h-sec" style={{ fontSize: 14, marginBottom: 10 }}>Cloudflare Turnstile</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <F label="Site Key" hint="Cloudflare Dashboard → Turnstile">
                <input className="input" value={cfg.turnstile_site_key} onChange={(e) => set('turnstile_site_key', e.target.value)} autoComplete="off" />
              </F>
              <F label="Secret Key" hint={cfg.has_turnstile_secret ? 'Сохранён. Оставьте пустым, чтобы не менять' : undefined}>
                <input className="input" type="password" value={turnstileSecret} onChange={(e) => setTurnstileSecret(e.target.value)} placeholder={cfg.has_turnstile_secret ? '••••••••••••' : ''} autoComplete="new-password" />
              </F>
            </div>
          </div>
        )}

        <button className="btn solid" disabled={busy} onClick={() => void save()}>
          {busy ? <Spinner size={15} /> : <Save size={15} />} Сохранить
        </button>
      </div>
    </div>
  );
};
