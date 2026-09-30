import React, { useState, useEffect } from 'react';
import {
  DollarSign, Users, Link, X, Edit2, Copy, MousePointer, ToggleLeft, ToggleRight, Trash2, RefreshCw, BarChart2,
} from 'lucide-react';
import { Modal, PageHead, Stat } from '../components/ui';
import { BOT_USERNAME, apiFetch } from '../lib/api';
import { fmtInt, fmtMoney } from '../lib/format';
import type { ToastType, TrackingLink, TrackingLinkUser } from '../lib/types';

export const TrackingLinksPage: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [links, setLinks] = useState<TrackingLink[]>([]);
  const [stats, setStats] = useState<{ total_links: number; total_clicks: number; total_unique_users: number; total_revenue: number; paid_users: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<(TrackingLink & { users?: TrackingLinkUser[] }) | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editing, setEditing] = useState<TrackingLink | null>(null);
  const [form, setForm] = useState({ name: '', code: '', promocode: '', welcome_message: '' });

  const fmtPct = (n: number) => `${n.toFixed(1)}%`;
  const fmtDate = (s: string) => { if (!s) return '—'; try { return new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return s; } };
  const copy = async (text: string, label = 'Ссылка') => { try { await navigator.clipboard.writeText(text); onToast('Скопировано', `${label} в буфере`, 'success'); } catch { onToast('Ошибка', 'Не удалось скопировать', 'error'); } };

  const load = async () => {
    setLoading(true);
    try {
      const [ld, sd] = await Promise.all([apiFetch('/panel/tracking-links'), apiFetch('/panel/tracking-links/stats')]);
      if (Array.isArray(ld)) setLinks(ld.map((l: any) => ({
        id: l.id, code: l.code, name: l.name || '', promocode: l.promocode || null, welcome_message: l.welcome_message || null,
        url: l.url, clicks: Number(l.clicks || 0), is_active: Boolean(l.is_active), created_at: l.created_at || '',
        unique_users: Number(l.unique_users || 0), new_users: Number(l.new_users || 0), total_revenue: Number(l.total_revenue || 0),
        paid_users: Number(l.paid_users || 0), active_subscriptions: Number(l.active_subscriptions || 0), total_keys: Number(l.total_keys || 0), conversion_rate: Number(l.conversion_rate || 0),
      })));
      if (sd) setStats(sd);
    } catch { onToast('Ошибка', 'Не удалось загрузить ссылки', 'error'); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const openDetail = async (link: TrackingLink) => { setDetail(link); setDetailLoading(true); try { const d = await apiFetch(`/panel/tracking-links/${link.id}`); setDetail(d); } catch { onToast('Ошибка', 'Не удалось загрузить детали', 'error'); } finally { setDetailLoading(false); } };

  const create = async () => {
    if (!form.name.trim()) { onToast('Ошибка', 'Укажите название кампании', 'error'); return; }
    try {
      const body: Record<string, string> = { name: form.name.trim() };
      if (form.code.trim()) body.code = form.code.trim();
      if (form.promocode.trim()) body.promocode = form.promocode.trim().toUpperCase();
      if (form.welcome_message.trim()) body.welcome_message = form.welcome_message.trim();
      const res = await apiFetch('/panel/tracking-links', { method: 'POST', body: JSON.stringify(body) });
      onToast('Готово', `Ссылка создана${res.url ? `: ${res.url}` : ''}`, 'success');
      setForm({ name: '', code: '', promocode: '', welcome_message: '' }); load();
    } catch (e: any) { onToast('Ошибка', e?.message || 'Не удалось создать', 'error'); }
  };
  const remove = async (id: number) => { if (!confirm('Удалить ссылку? Статистика по ней будет потеряна.')) return; try { await apiFetch(`/panel/tracking-links/${id}`, { method: 'DELETE' }); onToast('Готово', 'Ссылка удалена', 'success'); if (detail?.id === id) setDetail(null); load(); } catch { onToast('Ошибка', 'Не удалось удалить', 'error'); } };
  const saveEdit = async () => {
    if (!editing) return;
    try { await apiFetch(`/panel/tracking-links/${editing.id}`, { method: 'PUT', body: JSON.stringify({ name: editing.name, code: editing.code, promocode: editing.promocode || '', welcome_message: editing.welcome_message || '', is_active: editing.is_active }) }); onToast('Готово', 'Ссылка обновлена', 'success'); setEditing(null); load(); }
    catch (e: any) { onToast('Ошибка', e?.message || 'Не удалось обновить', 'error'); }
  };
  const toggle = async (link: TrackingLink) => { try { await apiFetch(`/panel/tracking-links/${link.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !link.is_active }) }); load(); } catch { onToast('Ошибка', 'Не удалось изменить статус', 'error'); } };

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Специальные ссылки" sub="Переходы, регистрации и оплаты рекламных кампаний" />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat title="Активных ссылок" value={stats?.total_links ?? links.length} icon={Link} />
        <Stat title="Всего переходов" value={fmtInt(stats?.total_clicks ?? 0)} icon={MousePointer} />
        <Stat title="Уникальных" value={fmtInt(stats?.total_unique_users ?? 0)} icon={Users} />
        <Stat title="Доход с кампаний" value={fmtMoney(stats?.total_revenue ?? 0)} icon={DollarSign} sub={`${stats?.paid_users ?? 0} оплатили`} />
      </div>

      <div className="card" style={{ padding: 24 }}>
        <h3 className="h-sec">Новая ссылка</h3>
        <p className="sub mt-1 mb-4">Формат: <span className="mono">t.me/{BOT_USERNAME}?start=trk_код</span></p>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Название (YouTube, VK Ads…)" />
          <input className="input mono" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') })} placeholder="Код (ad, yt1…)" />
          <input className="input mono" value={form.promocode} onChange={(e) => setForm({ ...form, promocode: e.target.value.toUpperCase() })} placeholder="Промокод (необяз.)" />
          <button className="btn solid" onClick={create}>Создать ссылку</button>
        </div>
        <textarea className="textarea mono mt-3" style={{ minHeight: 72, fontSize: 13 }} value={form.welcome_message} onChange={(e) => setForm({ ...form, welcome_message: e.target.value })}
          placeholder={"Сообщение при первом переходе (необяз.) — HTML/Markdown Telegram\n<b>Привет!</b> Держи скидку 🎁"} />
        <p className="faint mt-1" style={{ fontSize: 12 }}>Отправляется только при первом переходе. Поддерживается HTML Telegram.</p>
      </div>

      <div className="tbl-wrap">
        <div className="flex items-center justify-between" style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <h3 className="h-sec">Кампании</h3>
          <button className="icon-btn" onClick={load} title="Обновить"><RefreshCw size={15} /></button>
        </div>
        {loading ? <div className="sub" style={{ padding: 32, textAlign: 'center' }}>Загрузка…</div>
          : links.length === 0 ? <div style={{ padding: 48, textAlign: 'center' }}><Link size={36} className="faint" style={{ margin: '0 auto 12px' }} /><p className="muted">Ссылок пока нет</p><p className="sub mt-1">Создайте первую для рекламной кампании</p></div>
          : <div style={{ overflowX: 'auto' }}><table className="tbl" style={{ minWidth: 900 }}>
              <thead><tr><th>Кампания</th><th>Ссылка</th><th style={{ textAlign: 'center' }}>Переходы</th><th style={{ textAlign: 'center' }}>Уник.</th><th style={{ textAlign: 'center' }}>Новые</th><th style={{ textAlign: 'center' }}>Оплатили</th><th style={{ textAlign: 'right' }}>Доход</th><th style={{ textAlign: 'center' }}>Конв.</th><th style={{ textAlign: 'right' }}>Действия</th></tr></thead>
              <tbody>{links.map((l) => (
                <tr key={l.id} style={!l.is_active ? { opacity: 0.5 } : undefined}>
                  <td><div style={{ fontWeight: 500 }}>{l.name || l.code}</div><div className="faint mono" style={{ fontSize: 12 }}>trk_{l.code}{l.promocode ? ` · ${l.promocode}` : ''}</div></td>
                  <td><button className="btn sm" onClick={() => copy(l.url)}><Copy size={13} /> копировать</button></td>
                  <td className="muted" style={{ textAlign: 'center' }}>{l.clicks}</td>
                  <td className="muted" style={{ textAlign: 'center' }}>{l.unique_users}</td>
                  <td style={{ textAlign: 'center' }}>{l.new_users}</td>
                  <td className="muted" style={{ textAlign: 'center' }}>{l.paid_users}</td>
                  <td style={{ textAlign: 'right', fontWeight: 500 }}>{fmtMoney(l.total_revenue)}</td>
                  <td style={{ textAlign: 'center' }}><span className={`badge ${l.conversion_rate >= 10 ? 'solid' : l.conversion_rate >= 3 ? 'mute' : 'line'}`}>{fmtPct(l.conversion_rate)}</span></td>
                  <td style={{ textAlign: 'right' }}><span className="inline-flex gap-1">
                    <button className="icon-btn" onClick={() => openDetail(l)} title="Детали"><BarChart2 size={14} /></button>
                    <button className="icon-btn" onClick={() => toggle(l)} title={l.is_active ? 'Выключить' : 'Включить'}>{l.is_active ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}</button>
                    <button className="icon-btn" onClick={() => setEditing({ ...l })} title="Редактировать"><Edit2 size={14} /></button>
                    <button className="icon-btn danger" onClick={() => remove(l.id)} title="Удалить"><Trash2 size={14} /></button>
                  </span></td>
                </tr>
              ))}</tbody>
            </table></div>}
      </div>

      {editing && (
        <Modal onClose={() => setEditing(null)} title="Редактировать ссылку" width={440}
          footer={<><button className="btn block" onClick={() => setEditing(null)}>Отмена</button><button className="btn solid block" onClick={saveEdit}>Сохранить</button></>}>
          <div className="flex flex-col gap-3">
            <input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Название" />
            <input className="input mono" value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') })} placeholder="Код" />
            <input className="input mono" value={editing.promocode || ''} onChange={(e) => setEditing({ ...editing, promocode: e.target.value.toUpperCase() })} placeholder="Промокод" />
            <textarea className="textarea mono" style={{ minHeight: 80, fontSize: 13 }} value={editing.welcome_message || ''} onChange={(e) => setEditing({ ...editing, welcome_message: e.target.value })} placeholder={"Сообщение при первом переходе (HTML/Markdown)"} />
            <label className="flex items-center gap-2 muted" style={{ fontSize: 13, cursor: 'pointer' }}><input type="checkbox" checked={editing.is_active} onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })} /> Ссылка активна</label>
          </div>
        </Modal>
      )}

      {detail && (
        <div className="modal-backdrop" style={{ zIndex: 60 }} onClick={() => setDetail(null)}>
          <div className="modal" style={{ maxWidth: 860 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <div className="modal-title">{detail.name || detail.code}</div>
                <button className="btn sm mt-1" onClick={() => copy(detail.url)}><Copy size={13} /> {detail.url}</button>
              </div>
              <button className="icon-btn" onClick={() => setDetail(null)}><X size={18} /></button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3" style={{ padding: 20, borderBottom: '1px solid var(--border)' }}>
              <div className="inset" style={{ padding: 12 }}><div className="sub">Переходы</div><div className="stat-value" style={{ fontSize: 20 }}>{detail.clicks}</div></div>
              <div className="inset" style={{ padding: 12 }}><div className="sub">Уникальные</div><div className="stat-value" style={{ fontSize: 20 }}>{detail.unique_users}</div></div>
              <div className="inset" style={{ padding: 12 }}><div className="sub">Доход</div><div className="stat-value" style={{ fontSize: 20 }}>{fmtMoney(detail.total_revenue)}</div></div>
              <div className="inset" style={{ padding: 12 }}><div className="sub">Конверсия</div><div className="stat-value" style={{ fontSize: 20 }}>{fmtPct(detail.conversion_rate)}</div></div>
            </div>
            <div className="modal-body">
              <div className="eyebrow mb-3">Пользователи по ссылке</div>
              {detailLoading ? <div className="sub" style={{ textAlign: 'center', padding: 32 }}>Загрузка…</div>
                : !detail.users?.length ? <div className="sub" style={{ textAlign: 'center', padding: 32 }}>Пока никто не перешёл</div>
                : <table className="tbl">
                    <thead><tr><th>Пользователь</th><th>Переход</th><th style={{ textAlign: 'center' }}>Новый</th><th style={{ textAlign: 'center' }}>Подписки</th><th style={{ textAlign: 'right' }}>Потратил</th></tr></thead>
                    <tbody>{detail.users.map((u) => (
                      <tr key={u.user_id}>
                        <td><div>{u.full_name || u.username || `#${u.telegram_id}`}</div><div className="faint mono" style={{ fontSize: 12 }}>{u.telegram_id}{u.username ? ` · @${u.username}` : ''}</div></td>
                        <td className="muted">{fmtDate(u.visited_at)}</td>
                        <td style={{ textAlign: 'center' }}>{u.is_new_user ? 'да' : <span className="faint">—</span>}</td>
                        <td style={{ textAlign: 'center' }}>{u.active_keys > 0 ? `${u.active_keys} акт.` : u.has_paid ? 'была' : u.trial_used ? 'триал' : <span className="faint">—</span>}</td>
                        <td style={{ textAlign: 'right', fontWeight: 500 }}>{u.total_spent > 0 ? fmtMoney(u.total_spent) : '—'}</td>
                      </tr>
                    ))}</tbody>
                  </table>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
