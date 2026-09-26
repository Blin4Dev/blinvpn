import React, { useState, useEffect } from 'react';
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
    // Токен сброса передаём после «#» (#setup_token=…&reset=1): часть после «#»
    // не уходит на сервер и не попадает в логи nginx. Старый вариант «?» тоже
    // понимаем. Токен сразу убираем из адресной строки и истории браузера.
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

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setLoading(true);
    try {
      const res = await fetch('/api/panel/auth/verify-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ temp_token: tempToken, code: verifyCode }) });
      const data = await res.json();
      if (res.ok && data.session_token) { setPanelToken(data.session_token); onLogin(data.session_token); }
      else setError(data.error || 'Неверный код');
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
            {error && <div className="badge danger" style={{ width: '100%', padding: '10px 12px', justifyContent: 'flex-start' }}>{error}</div>}
            <button className="btn solid block" type="submit" disabled={loading || !username || !password} style={{ padding: 12 }}>
              {loading ? <><Spinner size={18} /> Вход…</> : 'Войти'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode} className="flex flex-col gap-4">
            <div className="inset sub" style={{ padding: 12 }}>Код подтверждения отправлен администраторам в Telegram.</div>
            <div><label className="field-label">Код</label><input className="input mono center" value={verifyCode} onChange={(e) => setVerifyCode(e.target.value)} placeholder="123456" required /></div>
            {error && <div className="badge danger" style={{ width: '100%', padding: '10px 12px', justifyContent: 'flex-start' }}>{error}</div>}
            <button className="btn solid block" type="submit" disabled={loading || !verifyCode} style={{ padding: 12 }}>{loading ? 'Проверка…' : 'Подтвердить'}</button>
          </form>
        )}
      </div>
    </div>
  );
}
