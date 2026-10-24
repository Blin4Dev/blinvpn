import React, { useEffect, useState } from 'react';
import { AlertTriangle, Wrench } from 'lucide-react';
import { Modal, Spinner, Toggle } from '../../components/ui';
import { apiFetch, parseApiErr } from '../../lib/api';
import type { ToastType } from '../../lib/types';

type St = { enabled: boolean; since: string | null; by: string | null; channel_url: string };

const fmt = (iso: string | null) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }); } catch { return iso; }
};

// режим техработ: мини-приложение показывает только страницу техработ
export const MaintenanceSettingsTab: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [st, setSt] = useState<St | null>(null);
  const [ask, setAsk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch('/panel/maintenance').then(setSt).catch((e) => onToast('Ошибка', parseApiErr(e, 'Не удалось загрузить'), 'error'));
  }, [onToast]);
  if (!st) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;

  const apply = async (enabled: boolean) => {
    setBusy(true);
    try {
      const r: St = await apiFetch('/panel/maintenance', { method: 'POST', body: JSON.stringify({ enabled }) });
      setSt(r);
      onToast(r.enabled ? 'Техработы включены' : 'Техработы выключены',
        r.enabled ? 'Пользователи видят страницу техработ' : 'Мини-приложение снова работает', r.enabled ? 'info' : 'success');
    } catch (e) {
      onToast('Ошибка', parseApiErr(e, 'Не удалось переключить'), 'error');
    } finally { setBusy(false); setAsk(null); }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="card" style={{ padding: 20 }}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2"><Wrench size={18} /><span className="h-sec">Режим техработ</span></div>
          {busy ? <Spinner size={16} /> : <Toggle on={st.enabled} onChange={() => setAsk(!st.enabled)} />}
        </div>
        <div className="sub" style={{ fontSize: 13, marginTop: 8 }}>
          {st.enabled
            ? `Включён ${fmt(st.since)}${st.by ? ` · ${st.by}` : ''}`
            : 'Мини-приложение покажет пользователям страницу техработ.'}
        </div>
      </div>

      {ask !== null && (
        <Modal onClose={() => setAsk(null)} title={ask ? 'Включить техработы?' : 'Выключить техработы?'} icon={AlertTriangle} width={460}
          footer={<><button className="btn" onClick={() => setAsk(null)}>Отмена</button>
            <button className="btn solid" disabled={busy} onClick={() => void apply(ask)}>{ask ? 'Включить' : 'Выключить'}</button></>}>
          <div className="sub">
            {ask
              ? 'Мини-приложение станет недоступно всем пользователям.'
              : 'Мини-приложение снова станет доступно.'}
          </div>
        </Modal>
      )}
    </div>
  );
};
