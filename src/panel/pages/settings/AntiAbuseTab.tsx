import React, { useState, useEffect } from 'react';
import { Save } from 'lucide-react';
import { Spinner, Toggle } from '../../components/ui';
import { apiFetch, parseApiErr } from '../../lib/api';
import type { ToastType } from '../../lib/types';

export const AntiAbuseSettingsTab: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [f, setF] = useState({
    aaMult: '2', aaIp: '2', aaGrace: '24', aaDays: '7', trialHwidMax: '2',
  });
  const [trialHwid, setTrialHwid] = useState(true);
  const [antiabuse, setAntiabuse] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  const load = async () => {
    setLoading(true);
    try {
      const m = await apiFetch('/panel/plans/meta');
      if (m) {
        setF({
          aaMult: String(m.antiabuse?.hwid_multiplier ?? 2), aaIp: String(m.antiabuse?.ip_extra ?? 2),
          aaGrace: String(m.antiabuse?.grace_hours ?? 24), aaDays: String(m.antiabuse?.warn_days ?? 7),
          trialHwidMax: String(m.trial_hwid_max ?? 2),
        });
        setTrialHwid(m.trial_hwid_enabled !== false);
        setAntiabuse(m.antiabuse_enabled !== false);
      }
    } catch { onToast('Ошибка', 'Не удалось загрузить настройки', 'error'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch('/panel/plans', {
        method: 'PUT',
        body: JSON.stringify({
          antiabuse_enabled: antiabuse,
          aa_hwid_multiplier: Number(f.aaMult), aa_ip_extra: Number(f.aaIp),
          aa_grace_hours: Number(f.aaGrace), aa_warn_days: Number(f.aaDays),
          trial_hwid_enabled: trialHwid, trial_hwid_max: Number(f.trialHwidMax),
        }),
      });
      onToast('Готово', 'Сохранено — мини-приложение подхватит сразу', 'success');
      load();
    } catch (e: any) { onToast('Ошибка', parseApiErr(e, 'Не удалось сохранить'), 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div className="card" style={{ padding: 24 }}>
      <h3 className="h-sec" style={{ paddingBottom: 16, marginBottom: 4 }}>Анти-абуз</h3>
      {loading ? <div className="sub">Загрузка…</div> : (
        <div className="flex flex-col gap-4">
          <div className="inset flex items-center justify-between gap-3" style={{ padding: 14 }}>
            <div><div style={{ fontWeight: 500 }}>Анти-абуз (HWID/IP)</div><div className="sub mt-0.5">Автобан подписки при нарушениях</div></div>
            <Toggle on={antiabuse} onChange={() => setAntiabuse(!antiabuse)} />
          </div>
          {antiabuse && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div><label className="field-label">Устройств больше лимита, раз</label><input className="input" type="number" min={2} max={10} value={f.aaMult} onChange={set('aaMult')} /></div>
              <div><label className="field-label">Одновременных IP сверх лимита</label><input className="input" type="number" min={1} max={20} value={f.aaIp} onChange={set('aaIp')} /></div>
              <div><label className="field-label">Время на исправление, часов</label><input className="input" type="number" min={1} max={168} value={f.aaGrace} onChange={set('aaGrace')} /></div>
              <div><label className="field-label">Предупреждение действует, дней</label><input className="input" type="number" min={1} max={60} value={f.aaDays} onChange={set('aaDays')} /></div>
            </div>
          )}
          <div className="inset flex items-center justify-between gap-3" style={{ padding: 14 }}>
            <div style={{ fontWeight: 500 }}>Защита пробного периода</div>
            <Toggle on={trialHwid} onChange={() => setTrialHwid(!trialHwid)} />
          </div>
          {trialHwid && (
            <div style={{ maxWidth: 320 }}><label className="field-label">Пробных аккаунтов на одно устройство</label><input className="input" type="number" min={1} max={10} value={f.trialHwidMax} onChange={set('trialHwidMax')} /></div>
          )}
          <div><button className="btn solid" onClick={save} disabled={saving}>{saving ? <Spinner size={16} /> : <Save size={16} />} Сохранить</button></div>
        </div>
      )}
    </div>
  );
};
