import React, { useState, useEffect } from 'react';
import {
  Users, Gift, Percent, Edit2, Trash2,
} from 'lucide-react';
import { Modal, PageHead, Stat } from '../components/ui';
import { apiFetch } from '../lib/api';
import { dateInputToIso, fmtDateRu, fmtInt, toDateInput } from '../lib/format';
import type { Promo, ToastType } from '../lib/types';

export const PromocodesStats: React.FC<{ promos: Promo[] }> = ({ promos }) => {
  const [stats, setStats] = useState<{ total: number; totalUses: number; activeCount: number } | null>(null);
  useEffect(() => { (async () => { try { const d = await apiFetch('/panel/promocodes/stats'); if (d) setStats(d); } catch (e) { console.error(e); } })(); }, []);
  const avgDiscount = promos.length ? Math.round(promos.reduce((s, p) => s + Number(p.value || 0), 0) / promos.length) : 0;
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Stat title="Активных кодов" value={stats ? stats.activeCount : promos.length} icon={Gift} />
      <Stat title="Активаций" value={stats ? fmtInt(stats.totalUses) : '0'} icon={Users} />
      <Stat title="Средняя скидка" value={`${avgDiscount}%`} icon={Percent} />
    </div>
  );
};

export const PromocodesPage: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [promos, setPromos] = useState<Promo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Promo | null>(null);
  const [form, setForm] = useState<{ code: string; name: string; value: string; limit: string; expires: string }>({ code: '', name: '', value: '', limit: '', expires: '' });

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiFetch('/panel/promocodes');
      setPromos(Array.isArray(data) ? data.map((p: any) => ({ id: p.id, code: p.code, name: String(p.name || ''), value: String(p.value ?? ''), uses: Number(p.uses_count || 0), limit: Number(p.uses_limit || 0), expires: String(p.expires_at || '') })) : []);
    } catch { onToast('Ошибка', 'Не удалось загрузить промокоды', 'error'); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    const value = Number(form.value);
    if (!form.code || !form.value || isNaN(value) || value <= 0 || value > 100) { onToast('Ошибка', 'Укажите код и скидку 1–100%', 'error'); return; }
    try {
      await apiFetch('/panel/promocodes', { method: 'POST', body: JSON.stringify({ code: form.code.toUpperCase(), name: form.name || null, value, uses_limit: form.limit ? Number(form.limit) : null, expires_at: dateInputToIso(form.expires), is_active: 1 }) });
      onToast('Готово', 'Промокод создан', 'success');
      setForm({ code: '', name: '', value: '', limit: '', expires: '' }); load();
    } catch (e) { onToast('Ошибка', e instanceof Error ? e.message : 'Не удалось создать', 'error'); }
  };
  const remove = async (id: number) => { if (!confirm('Удалить промокод?')) return; try { await apiFetch(`/panel/promocodes/${id}`, { method: 'DELETE' }); onToast('Готово', 'Промокод удалён', 'success'); load(); } catch { onToast('Ошибка', 'Не удалось удалить', 'error'); } };
  const save = async () => {
    if (!editing) return;
    const value = Number(editing.value);
    if (!editing.code || isNaN(value) || value <= 0 || value > 100) { onToast('Ошибка', 'Укажите код и скидку 1–100%', 'error'); return; }
    try {
      await apiFetch(`/panel/promocodes/${editing.id}`, { method: 'PUT', body: JSON.stringify({ code: editing.code, name: editing.name || null, value, uses_limit: editing.limit || null, expires_at: editing.expires ? (editing.expires.length <= 10 ? dateInputToIso(editing.expires) : editing.expires) : null }) });
      onToast('Готово', 'Промокод обновлён', 'success'); setEditing(null); load();
    } catch (e) { onToast('Ошибка', e instanceof Error ? e.message : 'Не удалось обновить', 'error'); }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Промокоды" sub="Скидочные коды. Активированный промокод действует 90 дней и только один раз." />
      <PromocodesStats promos={promos} />

      <div className="card" style={{ padding: 24 }}>
        <h3 className="h-sec mb-4">Новый промокод</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div><label className="field-label">Код</label><input className="input mono" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="НАПРИМЕР SALE20" /></div>
          <div><label className="field-label">Название</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Осенняя распродажа" /></div>
          <div><label className="field-label">Скидка, %</label><input className="input" type="number" min={1} max={100} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder="20" /></div>
          <div><label className="field-label">Активен до</label><input className="input" type="date" value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })} /></div>
          <div><label className="field-label">Лимит активаций <span className="faint">(необязательно)</span></label><input className="input" type="number" value={form.limit} onChange={(e) => setForm({ ...form, limit: e.target.value })} placeholder="∞" /></div>
        </div>
        <button className="btn solid mt-4" onClick={create}>Создать</button>
      </div>

      <div className="tbl-wrap">
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}><h3 className="h-sec">Список промокодов</h3></div>
        {loading ? <div className="sub" style={{ padding: 32, textAlign: 'center' }}>Загрузка…</div>
          : promos.length === 0 ? <div className="sub" style={{ padding: 32, textAlign: 'center' }}>Промокодов пока нет</div>
          : <div style={{ overflowX: 'auto' }}><table className="tbl">
              <thead><tr><th>Код</th><th>Название</th><th>Скидка</th><th>Активаций</th><th>Лимит</th><th>Активен до</th><th style={{ textAlign: 'right' }}>Действия</th></tr></thead>
              <tbody>{promos.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.code}</td><td className="muted">{p.name || '—'}</td><td style={{ fontWeight: 600 }}>{p.value}%</td>
                  <td className="muted">{p.uses}</td><td className="muted">{p.limit || '∞'}</td><td className="muted">{fmtDateRu(p.expires)}</td>
                  <td style={{ textAlign: 'right' }}><span className="inline-flex gap-2"><button className="icon-btn" onClick={() => setEditing({ ...p })}><Edit2 size={14} /></button><button className="icon-btn danger" onClick={() => remove(p.id)}><Trash2 size={14} /></button></span></td>
                </tr>
              ))}</tbody>
            </table></div>}
      </div>

      {editing && (
        <Modal onClose={() => setEditing(null)} title="Редактировать промокод" width={440}
          footer={<><button className="btn block" onClick={() => setEditing(null)}>Отмена</button><button className="btn solid block" onClick={save}>Сохранить</button></>}>
          <div className="flex flex-col gap-3">
            <div><label className="field-label">Код</label><input className="input mono" value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })} placeholder="Код" /></div>
            <div><label className="field-label">Название</label><input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Название" /></div>
            <div><label className="field-label">Скидка, %</label><input className="input" type="number" min={1} max={100} value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} placeholder="20" /></div>
            <div><label className="field-label">Активен до</label><input className="input" type="date" value={toDateInput(editing.expires)} onChange={(e) => setEditing({ ...editing, expires: e.target.value })} /></div>
            <div><label className="field-label">Лимит активаций</label><input className="input" type="number" value={editing.limit || ''} onChange={(e) => setEditing({ ...editing, limit: Number(e.target.value || 0) })} placeholder="∞" /></div>
          </div>
        </Modal>
      )}
    </div>
  );
};
