import { useState, useEffect } from 'react';
import {
  Home, DollarSign, Users, Mail, Gift, Percent, Link, Settings, Menu, X, Wallet, Lock, BarChart2, ClipboardList, Server,
} from 'lucide-react';
import { UserActionModal } from './components/UserActionModal';
import { Spinner, ToastContainer } from './components/ui';
import { apiFetch, clearPanelToken, getPanelToken, parseApiErr } from './lib/api';
import type { Toast, ToastType } from './lib/types';
import { Dashboard } from './pages/Dashboard';
import { FinancePage } from './pages/Finance';
import { LoginForm } from './pages/Login';
import { MailingPage } from './pages/Mailing';
import { PromocodesPage } from './pages/Promocodes';
import { PromotionsPage } from './pages/Promotions';
import { StatisticsPage } from './pages/Statistics';
import { SurveyPage } from './pages/Survey';
import { TrackingLinksPage } from './pages/TrackingLinks';
import { UsersPage } from './pages/Users';
import { WithdrawalsPage } from './pages/Withdrawals';
import { MonitoringPage } from './pages/monitoring/MonitoringPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { UserDetailPage } from './pages/user/UserDetailPage';

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    const token = getPanelToken();
    if (!token) { setIsAuthenticated(false); return; }
    fetch('/api/panel/stats/summary', { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } })
      .then((res) => { if (res.ok) setIsAuthenticated(true); else { clearPanelToken(); setIsAuthenticated(false); } })
      .catch(() => setIsAuthenticated(false));
  }, []);

  if (isAuthenticated === null) return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner size={36} /></div>;
  if (!isAuthenticated) return <LoginForm onLogin={() => setIsAuthenticated(true)} />;
  return <AuthenticatedApp onLogout={() => {
    // Завершаем сессию и на сервере, а не только забываем токен в браузере.
    const t = getPanelToken();
    if (t) { fetch('/api/panel/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${t}` } }).catch(() => {}); }
    clearPanelToken(); setIsAuthenticated(false);
  }} />;
}

export const NAV = [
  { group: 'Главное', items: [{ name: 'Главная', icon: Home }, { name: 'Статистика', icon: BarChart2 }, { name: 'Финансы', icon: DollarSign }] },
  { group: 'Пользователи', items: [{ name: 'Пользователи', icon: Users }, { name: 'Выводы', icon: Wallet }, { name: 'Опрос', icon: ClipboardList }] },
  { group: 'Маркетинг', items: [{ name: 'Рассылка', icon: Mail }, { name: 'Промокоды', icon: Gift }, { name: 'Акции', icon: Percent }, { name: 'Ссылки', icon: Link }] },
  { group: 'Другое', items: [{ name: 'Мониторинг', icon: Server }, { name: 'Настройки', icon: Settings }] },
];

// Прямые ссылки из форума / уведомлений: /withdrawals, /users/123
export function initialRoute(): { page: string; userId: number | null; nodeId?: number | null } {
  try {
    const path = window.location.pathname.replace(/\/+$/, '');
    if (path === '/monitoring') {
      const n = new URLSearchParams(window.location.search).get('node');
      return { page: 'Мониторинг', userId: null, nodeId: n && /^\d+$/.test(n) ? Number(n) : null };
    }
    const m = path.match(/^\/users\/(\d+)$/);
    if (m) return { page: 'Пользователи', userId: Number(m[1]) };
    if (path === '/withdrawals') return { page: 'Выводы', userId: null };
    if (path === '/statistics') return { page: 'Статистика', userId: null };
  } catch { /* ignore */ }
  return { page: 'Главная', userId: null };
}

export function AuthenticatedApp({ onLogout }: { onLogout: () => void }) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [route0] = useState(initialRoute);
  const [activePage, setActivePage] = useState(route0.page);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [detailUserId, setDetailUserId] = useState<number | null>(route0.userId);
  const [monNodeId, setMonNodeId] = useState<number | null>(route0.nodeId ?? null);
  useEffect(() => {
    // Адрес повторяет открытую страницу только для мониторинга (/monitoring, /monitoring?node=ID),
    // для остальных возвращаем корень, чтобы F5 не «залипал» на старой ссылке.
    const want = detailUserId != null ? '/'
      : activePage === 'Мониторинг' ? (monNodeId != null ? `/monitoring?node=${monNodeId}` : '/monitoring')
      : activePage === 'Статистика' ? '/statistics' : '/';
    if (window.location.pathname + window.location.search !== want) { try { window.history.replaceState(null, '', want); } catch { /* ignore */ } }
  }, [activePage, monNodeId, detailUserId]);
  const [userSearch, setUserSearch] = useState('');
  const [massActionType, setMassActionType] = useState<string | null>(null);

  const addToast = (title: string, message: string, type: ToastType = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((p) => [...p, { id, title, message, type }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 4000);
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <ToastContainer toasts={toasts} removeToast={(id) => setToasts((p) => p.filter((t) => t.id !== id))} />

      {massActionType && (
        <UserActionModal type={massActionType} onClose={() => setMassActionType(null)} onConfirm={async (val, notify) => {
          try {
            const r = await apiFetch('/panel/users/mass-action', { method: 'POST', body: JSON.stringify({ action: massActionType, value: val, notify }) });
            addToast('Готово', r?.message || `Выполнено · затронуто: ${r?.affected ?? 0}`, 'success');
          } catch (e: any) { addToast('Ошибка', parseApiErr(e, 'Не удалось выполнить действие'), 'error'); }
          setMassActionType(null);
        }} />
      )}

      {/* Sidebar */}
      <aside style={{
        position: 'fixed', insetBlock: 0, left: 0, zIndex: 50, width: 250,
        background: 'var(--surface)', borderRight: '1px solid var(--border)',
        transform: isMobileMenuOpen ? 'none' : 'translateX(-100%)', transition: 'transform var(--t)', overflowY: 'auto',
      }} className="md:!translate-x-0">
        <div className="flex items-center gap-3" style={{ padding: 20, borderBottom: '1px solid var(--border)' }}>
          <img src="/assets/logo.png" alt="" style={{ width: 34, height: 34, borderRadius: 8, objectFit: 'contain' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          <div><div className="h-sec">BlinVPN</div><div className="faint" style={{ fontSize: 12 }}>Панель управления</div></div>
        </div>
        <nav style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {NAV.map((section) => (
            <div key={section.group}>
              <div className="nav-group">{section.group}</div>
              <div className="flex flex-col gap-1">
                {section.items.map((item) => (
                  <button key={item.name} className={`nav-item ${activePage === item.name ? 'on' : ''}`}
                    onClick={() => { setActivePage(item.name); setDetailUserId(null); setMonNodeId(null); setIsMobileMenuOpen(false); }}>
                    <item.icon size={17} className={activePage === item.name ? '' : 'faint'} /> {item.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <main className="md:!ml-[250px]" style={{ minHeight: '100vh' }}>
        <div style={{ position: 'sticky', top: 0, zIndex: 30, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(10px)', borderBottom: '1px solid var(--border)' }}>
          <button className="icon-btn md:!hidden" onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}>{isMobileMenuOpen ? <X size={20} /> : <Menu size={20} />}</button>
          <div className="flex-1" />
          <button className="icon-btn danger" onClick={onLogout} title="Выход"><Lock size={16} /></button>
        </div>

        <div style={{ padding: 20 }} className="rise">
          {detailUserId != null ? (
            <UserDetailPage userId={detailUserId} onBack={() => setDetailUserId(null)} onToast={addToast} onOpenUser={(id) => setDetailUserId(id)} />
          ) : (
            <>
              {activePage === 'Главная' && <Dashboard onNavigate={(p) => { setActivePage(p); setMonNodeId(null); }} onOpenUser={(id) => setDetailUserId(id)} />}
              {activePage === 'Статистика' && <StatisticsPage onOpenUser={(id) => setDetailUserId(id)} />}
              {activePage === 'Финансы' && <FinancePage onToast={addToast} onOpenUser={(id) => setDetailUserId(id)} />}
              {activePage === 'Выводы' && <WithdrawalsPage onToast={addToast} onOpenUser={(id) => setDetailUserId(id)} />}
              {activePage === 'Пользователи' && <UsersPage userSearch={userSearch} setUserSearch={setUserSearch} setSelectedUser={(u) => setDetailUserId(u.id)} setMassActionType={setMassActionType} />}
              {activePage === 'Рассылка' && <MailingPage onToast={addToast} />}
              {activePage === 'Промокоды' && <PromocodesPage onToast={addToast} />}
              {activePage === 'Акции' && <PromotionsPage onToast={addToast} />}
              {activePage === 'Ссылки' && <TrackingLinksPage onToast={addToast} />}
              {activePage === 'Опрос' && <SurveyPage onToast={addToast} onOpenUser={(id) => setDetailUserId(id)} />}
              {activePage === 'Мониторинг' && <MonitoringPage onToast={addToast} nodeId={monNodeId} setNodeId={setMonNodeId} />}
              {activePage === 'Настройки' && <SettingsPage onToast={addToast} />}
            </>
          )}
        </div>
      </main>

      {isMobileMenuOpen && <div onClick={() => setIsMobileMenuOpen(false)} className="md:!hidden" style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,0.5)' }} />}
    </div>
  );
}
