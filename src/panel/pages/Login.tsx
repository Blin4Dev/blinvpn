import React, { useState, useEffect, useRef } from 'react';
import {
  Lock,
} from 'lucide-react';
import { Spinner } from '../components/ui';
import { setPanelToken } from '../lib/api';

export function LoginForm({ onLogin }: { onLogin: (token: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [tempToken, setTempToken] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [initInfo, setInitInfo] = useState<{ username?: string; password?: string; newAdmin?: boolean; passwordRegenerated?: boolean; message?: string } | null>(null);

  useEffect(() => {
// токен сброса в hash (#setup_token=…&reset=1), не уходит на сервер/в логи nginx
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const queryParams = new URLSearchParams(window.location.search);
    const setupToken = hashParams.get('setup_token') || queryParams.get('setup_token') || '';
    const wantReset = (hashParams.get('reset') || queryParams.get('reset')) === '1';
    if (setupToken) {
      try { window.history.replaceState(null, '', window.location.pathname); } catch { /* ignore */ }
    }
    const headers: Record<string, string> = {};
    if (setupToken) headers['X-Panel-Setup-Token'] = setupToken;
    fetch(`/api/panel/auth/init${wantReset && setupToken ? '?reset=1' : ''}`, { headers })
      .then((r) => r.json())
      .then((data) => {
        if (data.show_credentials && data.password && data.username) {
          setInitInfo({ username: data.username, password: data.password, newAdmin: !!data.new_admin, passwordRegenerated: !!data.password_regenerated, message: data.message });
          setUsername(data.username);
        }
      }).catch(() => {});
  }, []);

  const submitCreds = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setLoading(true);
    try {
      const res = await fetch('/api/panel/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const data = await res.json();
      if (res.ok && data.requires_2fa && data.temp_token) setTempToken(data.temp_token);
      else if (res.ok && data.session_token) {
        if (data.warning) window.alert(data.warning);
        setPanelToken(data.session_token); onLogin(data.session_token);
      }
      else setError(data.error || 'Неверные учётные данные');
    } catch { setError('Ошибка подключения к серверу'); }
    setLoading(false);
  };

  const submitCode = async (e?: React.FormEvent, value = verifyCode) => {
    e?.preventDefault();
    if (loading || value.length < 6) return;
    setError(''); setLoading(true);
    try {
      const res = await fetch('/api/panel/auth/verify-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ temp_token: tempToken, code: value }) });
      const data = await res.json();
      if (res.ok && data.session_token) { setPanelToken(data.session_token); onLogin(data.session_token); }
      else {
        // код одноразовый: после ошибки нужен новый вход
        setTempToken(''); setVerifyCode('');
        setError(`${data.error || 'Неверный код'}. Введите пароль ещё раз — придёт новый код.`);
      }
    } catch { setError('Ошибка подключения к серверу'); }
    setLoading(false);
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card-lg rise" style={{ padding: 32, width: '100%', maxWidth: 400, background: 'var(--surface)', border: '1px solid var(--border-strong)' }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div className="avatar" style={{ width: 56, height: 56, borderRadius: 14, margin: '0 auto 14px' }}>
            <img src="/assets/logo.png" alt="BlinVPN" style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 8 }}
              onError={(e) => { const img = e.currentTarget; img.style.display = 'none'; (img.nextElementSibling as HTMLElement | null)?.style.setProperty('display', 'block'); }} />
            <Lock size={26} style={{ display: 'none' }} />
          </div>
          <h1 className="h-page" style={{ fontSize: 22 }}>BlinVPN Panel</h1>
          <p className="sub mt-1">Вход в панель управления</p>
        </div>

        {initInfo?.password && (
          <div className="inset" style={{ padding: 14, marginBottom: 20 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>
              {initInfo.newAdmin ? 'Создан администратор' : initInfo.passwordRegenerated ? 'Пароль сброшен' : 'Данные для входа'}
            </div>
            <div className="sub">Логин: <code className="mono" style={{ color: 'var(--text)', userSelect: 'all' }}>{initInfo.username}</code></div>
            <div className="sub">Пароль: <code className="mono" style={{ color: 'var(--text)', userSelect: 'all', wordBreak: 'break-all' }}>{initInfo.password}</code></div>
            <div className="faint mt-2" style={{ fontSize: 12 }}>{initInfo.message || 'Показывается до первого входа. Сохраните.'}</div>
          </div>
        )}

        {!tempToken ? (
          <form onSubmit={submitCreds} className="flex flex-col gap-4">
            <div><label className="field-label">Логин</label><input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" required /></div>
            <div><label className="field-label">Пароль</label><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required /></div>
            {error && <div className="badge danger" style={{ width: '100%', padding: '10px 12px', justifyContent: 'flex-start', whiteSpace: 'normal', lineHeight: 1.4, borderRadius: 'var(--r-sm)' }}>{error}</div>}
            <button className="btn solid block" type="submit" disabled={loading || !username || !password} style={{ padding: 12 }}>
              {loading ? <><Spinner size={18} /> Вход…</> : 'Войти'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode} className="flex flex-col gap-4">
            <div className="inset sub" style={{ padding: 12 }}>Код подтверждения отправлен в Telegram.</div>
            <div><label className="field-label">Код</label>
              <OtpBoxes value={verifyCode} disabled={loading} error={!!error}
                onChange={(v) => { setVerifyCode(v); if (error) setError(''); if (v.length === 6) void submitCode(undefined, v); }} />
            </div>
            {error && <div className="badge danger" style={{ width: '100%', padding: '10px 12px', justifyContent: 'flex-start', whiteSpace: 'normal', lineHeight: 1.4, borderRadius: 'var(--r-sm)' }}>{error}</div>}
            <button className="btn solid block" type="submit" disabled={loading || verifyCode.length < 6} style={{ padding: 12 }}>{loading ? 'Проверка…' : 'Подтвердить'}</button>
          </form>
        )}
      </div>
    </div>
  );
}

// 6 квадратиков поверх одного настоящего поля: вставка из буфера и автоподстановка кода работают
function OtpBoxes({ value, onChange, disabled, error }: { value: string; onChange: (v: string) => void; disabled?: boolean; error?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [focus, setFocus] = useState(false);
  useEffect(() => { ref.current?.focus(); }, []);
  const active = Math.min(value.length, 5);
  return (
    <div style={{ position: 'relative' }} onClick={() => ref.current?.focus()}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
        {Array.from({ length: 6 }, (_, i) => {
          const ch = value[i] || '';
          const isActive = focus && !disabled && i === active && value.length < 6;
          return (
            <div key={i} className="otp-box" style={{
              borderColor: error ? 'var(--danger-line)' : isActive ? 'var(--accent)' : ch ? 'var(--border-strong)' : 'var(--border)',
              boxShadow: isActive ? '0 0 0 3px rgba(255, 107, 26, 0.15)' : 'none',
            }}>
              {ch || (isActive ? <span className="otp-caret" /> : null)}
            </div>
          );
        })}
      </div>
      <input ref={ref} value={value} disabled={disabled} inputMode="numeric" autoComplete="one-time-code" aria-label="Код подтверждения"
        maxLength={6} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.01, border: 'none', background: 'transparent', color: 'transparent', caretColor: 'transparent', fontSize: 16 }} />
    </div>
  );
}
