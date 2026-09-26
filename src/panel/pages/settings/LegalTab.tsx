import React, { useState, useEffect } from 'react';
import {
  Save,
} from 'lucide-react';
import { Spinner } from '../../components/ui';
import { apiFetch } from '../../lib/api';
import type { ToastType } from '../../lib/types';

export const LegalSettingsTab: React.FC<{
  kind: 'offer' | 'privacy';
  title: string;
  onToast: (t: string, m: string, ty: ToastType) => void;
}> = ({ kind, title, onToast }) => {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const path = kind === 'offer' ? '/panel/content/offer' : '/panel/content/privacy';

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const d = await apiFetch(path);
        setText(d?.text || '');
      } catch { onToast('Ошибка', `Не удалось загрузить: ${title}`, 'error'); }
      finally { setLoading(false); }
    })();
  }, [path]);

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch(path, { method: 'PUT', body: JSON.stringify({ text }) });
      onToast('Готово', `${title} сохранён — мини-приложение обновится сразу`, 'success');
    } catch { onToast('Ошибка', 'Не удалось сохранить', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div className="card" style={{ padding: 24 }}>
      <h3 className="h-sec" style={{ paddingBottom: 16, borderBottom: '1px solid var(--border)', marginBottom: 20 }}>{title}</h3>
      {loading ? <div className="sub">Загрузка…</div> : (
        <div className="flex flex-col gap-4">
          <p className="sub">Текст хранится в БД и отдаётся мини-приложению через API.</p>
          <textarea className="textarea mono" style={{ minHeight: 360, fontSize: 13, lineHeight: 1.5 }} value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn solid" style={{ alignSelf: 'flex-start' }} onClick={save} disabled={saving}>
            {saving ? <Spinner size={16} /> : <Save size={16} />} Сохранить
          </button>
        </div>
      )}
    </div>
  );
};
