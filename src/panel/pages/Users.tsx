import React, { useState } from 'react';
import {
  Settings, Search, Filter, Calendar, Database, Layers, ChevronDown, RefreshCw,
} from 'lucide-react';
import { PageHead, PaginationBar, Spinner, userStatusBadge } from '../components/ui';
import { DEFAULT_REF_RATE, fmtMoney } from '../lib/format';
import { useOutside } from '../lib/hooks';
import { mapApiUser } from '../lib/mappers';
import { usePaginatedList } from '../lib/pagination';
import type { User } from '../lib/types';

export const MASS_ACTIONS = [
  { t: 'MASS_ADD_DAYS', icon: Calendar, label: 'Добавить дни всем' },
  { t: 'MASS_RESET_TRAFFIC', icon: Database, label: 'Сбросить трафик всем' },
  { t: 'MASS_RESET_TRIAL', icon: RefreshCw, label: 'Сбросить пробный период' },
];

export const UsersPage: React.FC<{
  userSearch: string; setUserSearch: (s: string) => void; setSelectedUser: (u: User) => void; setMassActionType: (t: string | null) => void;
}> = ({ userSearch, setUserSearch, setSelectedUser, setMassActionType }) => {
  const [statusFilter, setStatusFilter] = useState<'all' | 'Active' | 'Trial' | 'Expired' | 'None' | 'Banned'>('all');
  const [showFilter, setShowFilter] = useState(false);
  const [showMass, setShowMass] = useState(false);
  const massRef = useOutside<HTMLDivElement>(() => setShowMass(false));
  const filterRef = useOutside<HTMLDivElement>(() => setShowFilter(false));

  const { items: users, total, page, totalPages, loading, error, nextPage, prevPage } = usePaginatedList({
    basePath: '/panel/users', search: userSearch,
    extraParams: { status: statusFilter === 'all' ? undefined : statusFilter },
    mapItem: mapApiUser,
    clientFilter: (u: User) => statusFilter === 'all' ? true : statusFilter === 'Banned' ? u.status === 'Banned' : u.status === statusFilter,
  });

  const filterLabels: Record<string, string> = { all: 'Все', Active: 'Активные', Trial: 'Пробные', Expired: 'Истекла', None: 'Нет подписки', Banned: 'Забанен' };

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Пользователи" sub="База клиентов">
        <div style={{ position: 'relative' }} ref={massRef}>
          <button className="btn solid" onClick={() => setShowMass(!showMass)}><Layers size={16} /> Массовые действия <ChevronDown size={15} style={{ transform: showMass ? 'rotate(180deg)' : 'none', transition: 'transform var(--t)' }} /></button>
          {showMass && (
            <div className="menu" style={{ right: 0 }}>
              {MASS_ACTIONS.map((a) => (
                <button key={a.t} className="menu-item" onClick={() => { setMassActionType(a.t); setShowMass(false); }}><a.icon size={15} className="faint" /> {a.label}</button>
              ))}
            </div>
          )}
        </div>
      </PageHead>

      <div className="flex gap-3">
        <div className="search flex-1">
          <Search className="ico" size={16} />
          <input className="input" value={userSearch} onChange={(e) => setUserSearch(e.target.value)} placeholder="Имя, username или ID…" />
        </div>
        <div style={{ position: 'relative' }} ref={filterRef}>
          <button className={`btn ${statusFilter !== 'all' ? 'solid' : ''}`} onClick={() => setShowFilter(!showFilter)}><Filter size={16} /> {filterLabels[statusFilter]}</button>
          {showFilter && (
            <div className="menu" style={{ right: 0, minWidth: 160 }}>
              {(['all', 'Active', 'Trial', 'Expired', 'None', 'Banned'] as const).map((v) => (
                <button key={v} className="menu-item" onClick={() => { setStatusFilter(v); setShowFilter(false); }}>{filterLabels[v]}</button>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && <div className="badge danger" style={{ width: '100%', padding: '10px 14px', justifyContent: 'flex-start' }}>{error}</div>}

      <div className="tbl-wrap">
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>Пользователь</th><th>Принёс</th><th>Баланс</th><th>Подписка</th><th>Статус</th><th style={{ textAlign: 'right' }}></th></tr></thead>
            <tbody>
              {loading && users.length === 0 ? <tr className="empty-row"><td colSpan={6}><Spinner size={18} className="inline-block mr-2" />Загрузка…</td></tr>
                : users.length === 0 ? <tr className="empty-row"><td colSpan={6}>Ничего не найдено</td></tr>
                : users.map((user: User) => {
                    const st = userStatusBadge(user.status, user.inBlacklist);
                    return (
                      <tr key={user.id} className="click" onClick={() => setSelectedUser(user)}>
                        <td><span className="flex items-center gap-3"><span className="avatar" style={{ width: 32, height: 32, fontSize: 12 }}>{user.username.replace('@', '').slice(0, 2).toUpperCase()}</span><span style={{ fontWeight: 500 }}>{user.username}</span></span></td>
                        <td style={{ fontWeight: 600 }}>{fmtMoney(user.revenue || 0)}</td>
                        <td style={{ fontWeight: 600 }}>{user.balance} ₽</td>
                        <td className="muted">{user.paidUntil}</td>
                        <td><span className={`badge ${st.cls}`}>{st.label}</span>{user.partnerRate !== DEFAULT_REF_RATE && <span className="badge mute" style={{ marginLeft: 6 }} title="Индивидуальный процент реферальной программы">Реф. {user.partnerRate}%</span>}{user.noRenew && <span className="badge line" style={{ marginLeft: 6 }}>Без продления</span>}</td>
                        <td style={{ textAlign: 'right' }}><span className="icon-btn" style={{ display: 'inline-flex' }}><Settings size={15} /></span></td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
      </div>

      <PaginationBar page={page} totalPages={totalPages} total={total} loading={loading} onPrev={prevPage} onNext={nextPage} />
    </div>
  );
};
