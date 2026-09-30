import React, { useState, useEffect, useRef } from 'react';
import {
  Home, DollarSign, Users, Mail, Gift, Percent, Link, Settings, Menu, X, Wallet, Lock, BarChart2, ClipboardList, Server, MessageCircle,
  Shuffle, Eye, UserCog, Coins, Bell, BellOff, ChevronDown,
} from 'lucide-react';
import { UserActionModal } from './components/UserActionModal';
import { Spinner, ToastContainer } from './components/ui';
import { apiFetch, clearPanelToken, getPanelToken, parseApiErr, setWriteGuard } from './lib/api';
import { MeContext, canOpenPage, isOwner, type Me } from './lib/access';
import { disablePush, enablePush, pushSupported, syncPush } from './lib/push';
import type { Toast, ToastType } from './lib/types';
import { Dashboard } from './pages/Dashboard';
import { FinancePage } from './pages/Finance';
import { LoginForm } from './pages/Login';
import { MailingPage } from './pages/Mailing';
import { PromocodesPage } from './pages/Promocodes';
import { PromotionsPage } from './pages/Promotions';
import { StaffPage } from './pages/staff/StaffPage';
import { SalaryPage } from './pages/staff/SalaryPage';
import { StatisticsPage } from './pages/Statistics';
import { SupportPage } from './pages/Support';
import { BalancerPage } from './pages/Balancer';
import { SurveyPage } from './pages/Survey';
import { TrackingLinksPage } from './pages/TrackingLinks';
import { UsersPage } from './pages/Users';
import { WithdrawalsPage } from './pages/Withdrawals';
import { MonitoringPage } from './pages/monitoring/MonitoringPage';
import { SETTINGS_SECTIONS, SettingsPage } from './pages/settings/SettingsPage';
import { UserDetailPage } from './pages/user/UserDetailPage';

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  // кто вошёл и что ему доступно
  const loadMe = () => {
    const token = getPanelToken();
    if (!token) { setIsAuthenticated(false); return; }
    fetch('/api/panel/auth/me', { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } })
      .then(async (res) => {
        if (res.ok) { setMe(await res.json()); setIsAuthenticated(true); }
        else { clearPanelToken(); setIsAuthenticated(false); }
      })
      .catch(() => setIsAuthenticated(false));
  };
  useEffect(() => { loadMe(); }, []);

  if (isAuthenticated === null || (isAuthenticated && !me)) return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner size={36} /></div>;
  if (!isAuthenticated) return <LoginForm onLogin={() => { setIsAuthenticated(null); loadMe(); }} />;
  return <MeContext.Provider value={me}><AuthenticatedApp me={me!} onLogout={async () => {
    // отписать push с этого устройства и закрыть сессию
    try { await disablePush(); } catch { /* */ }
    const t = getPanelToken();
    if (t) { fetch('/api/panel/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${t}` } }).catch(() => {}); }
    clearPanelToken(); setMe(null); setIsAuthenticated(false);
  }} /></MeContext.Provider>;
}

export const NAV = [
  { group: 'Главное', items: [{ name: 'Главная', icon: Home }, { name: 'Статистика', icon: BarChart2 }, { name: 'Финансы', icon: DollarSign }] },
  { group: 'Пользователи', items: [{ name: 'Пользователи', icon: Users }, { name: 'Выводы', icon: Wallet }, { name: 'Опрос', icon: ClipboardList }] },
  { group: 'Поддержка', items: [{ name: 'Поддержка', icon: MessageCircle }, { name: 'Сотрудники', icon: UserCog }, { name: 'Зарплата', icon: Coins }] },
  { group: 'Маркетинг', items: [{ name: 'Рассылка', icon: Mail }, { name: 'Промокоды', icon: Gift }, { name: 'Акции', icon: Percent }, { name: 'Ссылки', icon: Link }] },
  { group: 'Другое', items: [{ name: 'Мониторинг', icon: Server }, { name: 'Балансировщик', icon: Shuffle }, { name: 'Настройки', icon: Settings }] },
];

// пути страниц (f5, назад, прямые ссылки)
const PAGE_PATHS: Record<string, string> = {
  'Главная': '/', 'Статистика': '/statistics', 'Финансы': '/finance',
  'Пользователи': '/users', 'Поддержка': '/support', 'Выводы': '/withdrawals', 'Опрос': '/survey',
  'Рассылка': '/mailing', 'Промокоды': '/promocodes', 'Акции': '/promotions', 'Ссылки': '/links',
  'Мониторинг': '/monitoring', 'Балансировщик': '/balancer', 'Настройки': '/settings', 'Сотрудники': '/staff', 'Зарплата': '/salary',
};
export const SETTINGS_TABS = ['prices', 'antiabuse', 'offer', 'privacy', 'squads', 'mail', 'forum', 'backups', 'storage'] as const;
export type SettingsTab = typeof SETTINGS_TABS[number];

type Route = { page: string; userId: number | null; nodeId: number | null; tab: SettingsTab; chatId?: number | null };

export function parseRoute(pathname: string, search: string): Route {
  const path = pathname.replace(/\/+$/, '') || '/';
  const base: Route = { page: 'Главная', userId: null, nodeId: null, tab: 'prices' };
  const u = path.match(/^\/users\/(\d+)$/);
  if (u) return { ...base, page: 'Пользователи', userId: Number(u[1]) };
  const sc = path.match(/^\/support(?:\/(\d+|team))?$/);
  // /support/team = чат сотрудников (chatId 0)
  if (sc) return { ...base, page: 'Поддержка', chatId: sc[1] === 'team' ? 0 : sc[1] ? Number(sc[1]) : null };
  if (path === '/monitoring') {
    const n = new URLSearchParams(search).get('node');
    return { ...base, page: 'Мониторинг', nodeId: n && /^\d+$/.test(n) ? Number(n) : null };
  }
  // старый /settings/xbm → балансировщик
  if (path === '/settings/xbm') return { ...base, page: 'Балансировщик' };
  const st = path.match(/^\/settings(?:\/([a-z]+))?$/);
  if (st) {
    const tab = (SETTINGS_TABS as readonly string[]).includes(st[1] || '') ? (st[1] as SettingsTab) : 'prices';
    return { ...base, page: 'Настройки', tab };
  }
  const page = Object.keys(PAGE_PATHS).find((k) => PAGE_PATHS[k] === path);
  return page ? { ...base, page } : base;
}

export function buildPath(r: Route): string {
  if (r.userId != null) return `/users/${r.userId}`;
  if (r.page === 'Мониторинг' && r.nodeId != null) return `/monitoring?node=${r.nodeId}`;
  if (r.page === 'Поддержка' && r.chatId != null) return r.chatId === 0 ? '/support/team' : `/support/${r.chatId}`;
  if (r.page === 'Настройки') return r.tab === 'prices' ? '/settings' : `/settings/${r.tab}`;
  return PAGE_PATHS[r.page] || '/';
}

export function AuthenticatedApp({ onLogout, me }: { onLogout: () => void; me: Me }) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [route0] = useState(() => {
    const r = parseRoute(window.location.pathname, window.location.search);
    if (r.userId != null || canOpenPage(me, r.page)) return r;
    // нет доступа: первая доступная страница
    const first = NAV.flatMap((g) => g.items).find((i) => canOpenPage(me, i.name));
    return { ...r, page: first?.name || r.page };
  });
  const [activePage, setActivePage] = useState(route0.page);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [detailUserId, setDetailUserId] = useState<number | null>(route0.userId);
  const [monNodeId, setMonNodeId] = useState<number | null>(route0.nodeId);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(route0.tab);
  const [settingsOpen, setSettingsOpen] = useState(route0.page === 'Настройки');
  const [chatId, setChatId] = useState<number | null>(route0.chatId ?? null);
  // непрочитанные у пункта «поддержка»
  const [supportUnread, setSupportUnread] = useState(0);
  const canSupport = canOpenPage(me, 'Поддержка');
  useEffect(() => {
    if (!canSupport) return;
    const load = () => apiFetch('/panel/support/unread').then((r) => setSupportUnread(Number(r?.chats || 0) + Number(r?.team || 0))).catch(() => {});
    load(); const t = setInterval(load, 15000);
    window.addEventListener('support-unread', load);
    return () => { clearInterval(t); window.removeEventListener('support-unread', load); };
  }, [canSupport]);
  const firstRun = useRef(true);

  // синхронизация состояния → url
  useEffect(() => {
    const want = buildPath({ page: activePage, userId: detailUserId, nodeId: monNodeId, tab: settingsTab, chatId });
    const cur = window.location.pathname + window.location.search;
    if (cur === want) return;  // после «назад» адрес уже совпадает
    try {
      if (firstRun.current) window.history.replaceState(null, '', want);
      else window.history.pushState(null, '', want);
    } catch { /* ignore */ }
  }, [activePage, monNodeId, detailUserId, settingsTab, chatId]);
  useEffect(() => { firstRun.current = false; }, []);  // после первого синка адреса

  // назад/вперёд браузера → state
  useEffect(() => {
    const onPop = () => {
      const r = parseRoute(window.location.pathname, window.location.search);
      setActivePage(r.page); setDetailUserId(r.userId); setMonNodeId(r.nodeId); setSettingsTab(r.tab); setChatId(r.chatId ?? null);
      window.scrollTo(0, 0);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const [userSearch, setUserSearch] = useState('');
  const [massActionType, setMassActionType] = useState<string | null>(null);

  // оператор правит только своего пользователя в работе, иначе read-only
  const [canManage, setCanManage] = useState<boolean | null>(null);
  useEffect(() => {
    setCanManage(null);
    if (detailUserId == null || me.role !== 'operator') return;
    apiFetch(`/panel/users/${detailUserId}/can-manage`).then((r) => setCanManage(!!r?.can_manage)).catch(() => setCanManage(false));
  }, [detailUserId, me.role]);
  const readOnly = me.role === 'operator' && detailUserId != null && canManage !== true;
  setWriteGuard(readOnly ? 'Менять можно только пользователя, чьё обращение у вас в работе' : null);
  const pageAllowed = detailUserId != null ? canOpenPage(me, 'Пользователи') : canOpenPage(me, activePage);

  // web push
  const [pushOn, setPushOn] = useState(false);
  useEffect(() => { syncPush().then(setPushOn).catch(() => {}); }, []);
  const togglePush = async () => {
    try {
      if (pushOn) { await disablePush(); setPushOn(false); addToast('Уведомления', 'Отключены на этом устройстве', 'success'); }
      else { await enablePush(); setPushOn(true); addToast('Уведомления', 'Включены — придут даже при закрытой панели', 'success'); }
    } catch (e: any) { addToast('Уведомления', parseApiErr(e, e?.message || 'Не удалось'), 'error'); }
  };
  const visibleNav = NAV.map((g) => ({ ...g, items: g.items.filter((i) => canOpenPage(me, i.name)) })).filter((g) => g.items.length);

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
          {visibleNav.map((section) => (
            <div key={section.group}>
              <div className="nav-group">{section.group}</div>
              <div className="flex flex-col gap-1">
                {section.items.map((item) => item.name === 'Настройки' ? (
                  <React.Fragment key={item.name}>
                    <button className={`nav-item ${activePage === item.name && !settingsOpen ? 'on' : ''}`}
                      onClick={() => setSettingsOpen(!settingsOpen)}>
                      <item.icon size={17} className={activePage === item.name ? '' : 'faint'} /> {item.name}
                      <ChevronDown size={15} className="faint" style={{ marginLeft: 'auto', transform: settingsOpen ? 'rotate(180deg)' : 'none', transition: 'transform var(--t)' }} />
                    </button>
                    {settingsOpen && (
                      <div className="flex flex-col gap-1" style={{ paddingLeft: 14, borderLeft: '1px solid var(--border)', marginLeft: 18 }}>
                        {SETTINGS_SECTIONS.map((t) => (
                          <button key={t.id} className={`nav-item ${activePage === 'Настройки' && settingsTab === t.id ? 'on' : ''}`} style={{ padding: '7px 10px', fontSize: 13 }}
                            onClick={() => { setActivePage('Настройки'); setSettingsTab(t.id); setDetailUserId(null); setMonNodeId(null); setChatId(null); setIsMobileMenuOpen(false); }}>
                            <t.icon size={15} className={activePage === 'Настройки' && settingsTab === t.id ? '' : 'faint'} /> {t.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </React.Fragment>
                ) : (
                  <button key={item.name} className={`nav-item ${activePage === item.name ? 'on' : ''}`}
                    onClick={() => { setActivePage(item.name); setDetailUserId(null); setMonNodeId(null); setChatId(null); setIsMobileMenuOpen(false); }}>
                    <item.icon size={17} className={activePage === item.name ? '' : 'faint'} /> {item.name}
                    {item.name === 'Поддержка' && supportUnread > 0 && (
                      <span style={{ marginLeft: 'auto', minWidth: 20, height: 20, padding: '0 6px', borderRadius: 10, background: '#fff', color: '#000', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{supportUnread}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <main className="md:!ml-[250px]" style={{ minHeight: '100vh' }}>
        <div style={{ position: 'sticky', top: 0, zIndex: 30, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(10px)', borderBottom: '1px solid var(--border)' }}>
          <button className="icon-btn md:!hidden" onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}>{isMobileMenuOpen ? <X size={20} /> : <Menu size={20} />}</button>
          <div className="flex-1" />
          {readOnly && <span className="badge" style={{ marginRight: 10 }}><Eye size={13} /> Только просмотр</span>}
          {pushSupported() && (
            <button className="icon-btn" style={{ marginRight: 8 }} onClick={togglePush} title={pushOn ? 'Push-уведомления включены — выключить' : 'Включить push-уведомления'}>
              {pushOn ? <Bell size={16} /> : <BellOff size={16} className="faint" />}
            </button>
          )}
          <span className="sub" style={{ fontSize: 13, marginRight: 12 }} title={isOwner(me) ? 'Владелец панели' : `${me.role === 'curator' ? 'Куратор' : 'Оператор'} · ${me.username}`}>
            {isOwner(me) ? 'Администратор' : `${me.name} · ${me.role === 'curator' ? 'куратор' : 'оператор'}`}
          </span>
          <button className="icon-btn danger" onClick={onLogout} title="Выход"><Lock size={16} /></button>
        </div>

        <div style={{ padding: 20 }} className="rise">
          {!pageAllowed ? (
            <div className="card flex flex-col items-center justify-center sub" style={{ padding: 40, gap: 10 }}>
              <Lock size={28} className="faint" />
              <div>Нет доступа к этому разделу</div>
            </div>
          ) : detailUserId != null ? (
            <UserDetailPage userId={detailUserId} onBack={() => setDetailUserId(null)} onToast={addToast} onOpenUser={(id) => setDetailUserId(id)} />
          ) : (
            <>
              {activePage === 'Главная' && <Dashboard onNavigate={(p) => { setActivePage(p); setMonNodeId(null); }} onOpenUser={(id) => setDetailUserId(id)} />}
              {activePage === 'Статистика' && <StatisticsPage onOpenUser={(id) => setDetailUserId(id)} />}
              {activePage === 'Финансы' && <FinancePage onToast={addToast} onOpenUser={(id) => setDetailUserId(id)} />}
              {activePage === 'Поддержка' && <SupportPage chatId={chatId} setChatId={setChatId} onOpenUser={(id) => setDetailUserId(id)} onToast={addToast} />}
              {activePage === 'Выводы' && <WithdrawalsPage onToast={addToast} onOpenUser={(id) => setDetailUserId(id)} />}
              {activePage === 'Пользователи' && <UsersPage userSearch={userSearch} setUserSearch={setUserSearch} setSelectedUser={(u) => setDetailUserId(u.id)} setMassActionType={setMassActionType} />}
              {activePage === 'Рассылка' && <MailingPage onToast={addToast} />}
              {activePage === 'Промокоды' && <PromocodesPage onToast={addToast} />}
              {activePage === 'Акции' && <PromotionsPage onToast={addToast} />}
              {activePage === 'Ссылки' && <TrackingLinksPage onToast={addToast} />}
              {activePage === 'Опрос' && <SurveyPage onToast={addToast} onOpenUser={(id) => setDetailUserId(id)} />}
              {activePage === 'Балансировщик' && <BalancerPage onToast={addToast} />}
              {activePage === 'Мониторинг' && <MonitoringPage onToast={addToast} nodeId={monNodeId} setNodeId={setMonNodeId} />}
              {activePage === 'Настройки' && <SettingsPage onToast={addToast} tab={settingsTab} onTab={setSettingsTab} />}
              {activePage === 'Сотрудники' && <StaffPage onToast={addToast} />}
              {activePage === 'Зарплата' && <SalaryPage />}
            </>
          )}
        </div>
      </main>

      {isMobileMenuOpen && <div onClick={() => setIsMobileMenuOpen(false)} className="md:!hidden" style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,0.5)' }} />}
    </div>
  );
}
