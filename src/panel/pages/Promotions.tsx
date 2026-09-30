import React, { useState, useEffect } from 'react';
import {
  Edit2, Trash2,
} from 'lucide-react';
import { Modal, PageHead } from '../components/ui';
import { apiFetch } from '../lib/api';
import type { ToastType } from '../lib/types';

export type PromotionType = 'global_discount';

export type PromotionItem = {
  id: number; name: string; type: PromotionType; value: number; min_amount: number | null;
  max_amount: number | null; uses_limit: number | null; uses_count: number; expires_at: string | null; is_active: boolean;
};

export const PromotionsPage: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const emptyForm = { name: '', value: '', uses_limit: '', expires_at: '', is_active: true };
  const [items, setItems] = useState<PromotionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<PromotionItem | null>(null);

  const load = async () => { setLoading(true); try { const d = await apiFetch('/panel/promotions'); setItems(Array.isArray(d) ? d : []); } catch { onToast('Ошибка', 'Не удалось загрузить акции', 'error'); setItems([]); } finally { setLoading(false); } };
  useEffect(() => { load(); }, []);

  const toPayload = (src: typeof form | PromotionItem) => {
    const isEdit = 'id' in src;
    const valueRaw = isEdit ? String((src as PromotionItem).value) : (src as typeof form).value;
    const limitRaw = isEdit ? ((src as PromotionItem).uses_limit != null ? String((src as PromotionItem).uses_limit) : '') : (src as typeof form).uses_limit;
    const expiresRaw = isEdit ? ((src as PromotionItem).expires_at || '') : ((src as typeof form).expires_at || '');
    let expires_at: string | null = null;
    if (expiresRaw) { const d = new Date(expiresRaw); expires_at = Number.isNaN(d.getTime()) ? String(expiresRaw) : d.toISOString(); }
    return {
      name: src.name.trim(), type: 'global_discount' as PromotionType, value: valueRaw,
      uses_limit: limitRaw !== '' ? Number(limitRaw) : null,
      expires_at, is_active: isEdit ? (src as PromotionItem).is_active : (src as typeof form).is_active,
    };
  };
  const parseApiError = (e: any, fallback: string) => { try { const p = JSON.parse(e?.message || ''); if (p?.error) return String(p.error); } catch {} return fallback; };

  const create = async () => {
    if (!form.name.trim() || !form.value || !form.expires_at) { onToast('Ошибка', 'Заполните название, скидку и дату', 'error'); return; }
    try { await apiFetch('/panel/promotions', { method: 'POST', body: JSON.stringify(toPayload(form)) }); onToast('Готово', 'Скидка создана', 'success'); setForm(emptyForm); load(); }
    catch (e: any) { onToast('Ошибка', parseApiError(e, 'Не удалось создать'), 'error'); }
  };
  const save = async () => {
    if (!editing || !editing.name.trim() || !editing.expires_at) { onToast('Ошибка', 'Заполните название и дату', 'error'); return; }
    try { await apiFetch(`/panel/promotions/${editing.id}`, { method: 'PUT', body: JSON.stringify(toPayload(editing)) }); onToast('Готово', 'Скидка обновлена', 'success'); setEditing(null); load(); }
    catch (e: any) { onToast('Ошибка', parseApiError(e, 'Не удалось обновить'), 'error'); }
  };
  const remove = async (id: number) => { if (!confirm('Удалить скидку?')) return; try { await apiFetch(`/panel/promotions/${id}`, { method: 'DELETE' }); onToast('Готово', 'Скидка удалена', 'success'); load(); } catch { onToast('Ошибка', 'Не удалось удалить', 'error'); } };
  const toggle = async (item: PromotionItem) => { try { await apiFetch(`/panel/promotions/${item.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !item.is_active }) }); load(); } catch { onToast('Ошибка', 'Не удалось изменить статус', 'error'); } };

  const fmtExpires = (s: string | null) => { if (!s) return 'Без срока'; try { return new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return s; } };
  const toLocal = (s: string | null) => { if (!s) return ''; try { const d = new Date(s); if (Number.isNaN(d.getTime())) return ''; const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; } catch { return ''; } };

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Акции" sub="Глобальная скидка — действует на все тарифы для всех пользователей без промокода." />

      <div className="card" style={{ padding: 24 }}>
        <h3 className="h-sec mb-4">Новая скидка</h3>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Название (напр. «Осенняя −20%»)" />
            <input className="input" type="number" step="any" min={1} max={100} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder="Скидка % (напр. 15)" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input className="input" type="number" value={form.uses_limit} onChange={(e) => setForm({ ...form, uses_limit: e.target.value })} placeholder="Лимит использований (необяз.)" />
            <input className="input" type="datetime-local" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} />
          </div>
          <button className="btn solid" style={{ alignSelf: 'flex-start' }} onClick={create}>Создать</button>
        </div>
      </div>

      <div className="tbl-wrap">
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}><h3 className="h-sec">Список скидок</h3></div>
        {loading ? <div className="sub" style={{ padding: 32, textAlign: 'center' }}>Загрузка…</div>
          : items.length === 0 ? <div className="sub" style={{ padding: 32, textAlign: 'center' }}>Скидок пока нет</div>
          : <div style={{ overflowX: 'auto' }}><table className="tbl" style={{ minWidth: 760 }}>
              <thead><tr><th>Название</th><th>Скидка</th><th>Исп.</th><th>До</th><th>Статус</th><th style={{ textAlign: 'right' }}>Действия</th></tr></thead>
              <tbody>{items.map((p) => (
                <tr key={p.id} style={!p.is_active ? { opacity: 0.5 } : undefined}>
                  <td style={{ fontWeight: 500 }}>{p.name}</td>
                  <td style={{ fontWeight: 600 }}>{`−${p.value}%`}</td>
                  <td className="muted">{p.uses_count}{p.uses_limit != null ? ` / ${p.uses_limit}` : ''}</td>
                  <td className="muted" style={{ fontSize: 13 }}>{fmtExpires(p.expires_at)}</td>
                  <td><button className={`badge ${p.is_active ? 'solid' : 'line'}`} onClick={() => toggle(p)}>{p.is_active ? 'Активна' : 'Выкл'}</button></td>
                  <td style={{ textAlign: 'right' }}><span className="inline-flex gap-2"><button className="icon-btn" onClick={() => setEditing({ ...p })}><Edit2 size={14} /></button><button className="icon-btn danger" onClick={() => remove(p.id)}><Trash2 size={14} /></button></span></td>
                </tr>
              ))}</tbody>
            </table></div>}
      </div>

      {editing && (
        <Modal onClose={() => setEditing(null)} title="Редактировать скидку" width={520}
          footer={<><button className="btn block" onClick={() => setEditing(null)}>Отмена</button><button className="btn solid block" onClick={save}>Сохранить</button></>}>
          <div className="flex flex-col gap-3">
            <div><label className="field-label">Название</label><input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Название" /></div>
            <div><label className="field-label">Скидка, %</label><input className="input" type="number" step="any" min={1} max={100} value={editing.value} onChange={(e) => setEditing({ ...editing, value: Number(e.target.value) })} /></div>
            <div><label className="field-label">Лимит использований</label><input className="input" type="number" value={editing.uses_limit ?? ''} onChange={(e) => setEditing({ ...editing, uses_limit: e.target.value === '' ? null : Number(e.target.value) })} placeholder="∞" /></div>
            <div><label className="field-label">Активна до</label><input className="input" type="datetime-local" value={toLocal(editing.expires_at)} onChange={(e) => setEditing({ ...editing, expires_at: e.target.value || null })} /></div>
            <label className="flex items-center gap-2 muted" style={{ fontSize: 13, cursor: 'pointer' }}><input type="checkbox" checked={!!editing.is_active} onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })} /> Активна</label>
          </div>
        </Modal>
      )}
    </div>
  );
};
