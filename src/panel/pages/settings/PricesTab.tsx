import React, { useState, useEffect } from 'react';
import {
  Save,
} from 'lucide-react';
import { Spinner, Toggle } from '../../components/ui';
import { apiFetch, parseApiErr } from '../../lib/api';
import type { ToastType } from '../../lib/types';

export const Section: React.FC<{ title: string; sub?: string; children: React.ReactNode }> = ({ title, sub, children }) => (
  <div className="flex flex-col gap-4" style={{ paddingTop: 20, borderTop: '1px solid var(--border)' }}>
    <div><div style={{ fontWeight: 600 }}>{title}</div>{sub && <div className="sub mt-0.5">{sub}</div>}</div>
    {children}
  </div>
);

export const PricesSettingsTab: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [f, setF] = useState({
    base: '99', extra: '40', paidGb: '100', trafficReset: '0',
    trialDays: '3', trialGb: '5', trialDevices: '1',
  });
  const [trialEnabled, setTrialEnabled] = useState(true);
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
          base: String(m.base_price ?? 99), extra: String(m.extra_device_price ?? 40),
          paidGb: String(m.paid_traffic_gb ?? 100), trafficReset: String(m.traffic_reset_price ?? 0),
          trialDays: String(m.trial_days ?? 3), trialGb: String(m.trial_traffic_gb ?? 5), trialDevices: String(m.trial_devices ?? 1),
        });
        setTrialEnabled(m.trial_enabled !== false);
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
          base_price: Number(f.base), extra_device_price: Number(f.extra),
          paid_traffic_gb: Number(f.paidGb), traffic_reset_price: Number(f.trafficReset),
          trial_enabled: trialEnabled, trial_days: Number(f.trialDays),
          trial_traffic_gb: Number(f.trialGb), trial_devices: Number(f.trialDevices),
          antiabuse_enabled: antiabuse,
        }),
      });
      onToast('Готово', 'Сохранено — мини-приложение подхватит сразу', 'success');
      load();
    } catch (e: any) { onToast('Ошибка', parseApiErr(e, 'Не удалось сохранить'), 'error'); }
    finally { setSaving(false); }
  };

  const base = Number(f.base) || 0;
  const extra = Number(f.extra) || 0;
  const example = [1, 2, 3, 5].map((n) => ({ n, price: Math.round((base + extra * (n - 1)) * 100) / 100 }));
  const devWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'устройство' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'устройства' : 'устройств');

  return (
    <div className="card" style={{ padding: 24 }}>
      <h3 className="h-sec" style={{ paddingBottom: 16, marginBottom: 4 }}>Цены и подписки</h3>
      {loading ? <div className="sub">Загрузка…</div> : (
        <div className="flex flex-col gap-6">
          <Section title="Платная подписка" sub="Цена = базовая цена за 1 устройство + цена за каждое следующее. Изменения сразу видны в мини-приложении.">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div><label className="field-label">Базовая цена (1 устройство), ₽/мес</label><input className="input" type="number" min={1} value={f.base} onChange={set('base')} /></div>
              <div><label className="field-label">Цена доп. устройства, ₽/мес</label><input className="input" type="number" min={0} value={f.extra} onChange={set('extra')} /></div>
              <div><label className="field-label">Трафик в месяц, ГБ (0 = без лимита)</label><input className="input" type="number" min={0} value={f.paidGb} onChange={set('paidGb')} /></div>
              <div><label className="field-label">Досрочный сброс трафика, ₽ (0 = выкл.)</label><input className="input" type="number" min={0} value={f.trafficReset} onChange={set('trafficReset')} /></div>
            </div>
            <div className="inset flex flex-wrap gap-x-6 gap-y-2" style={{ padding: 14, fontSize: 13 }}>
              <span className="faint">Так увидят цены:</span>
              {example.map((e) => <span key={e.n}>{e.n} {devWord(e.n)} — <b>{e.price} ₽</b></span>)}
            </div>
          </Section>

          <Section title="Пробная подписка" sub="Выдаётся один раз новым пользователям в Telegram.">
            <div className="inset flex items-center justify-between gap-3" style={{ padding: 14 }}>
              <div><div style={{ fontWeight: 500 }}>Пробный период включён</div><div className="sub mt-0.5">Выключите — и взять пробный будет нельзя, только оплата.</div></div>
              <Toggle on={trialEnabled} onChange={() => setTrialEnabled(!trialEnabled)} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4" style={{ opacity: trialEnabled ? 1 : 0.5 }}>
              <div><label className="field-label">Срок, дней</label><input className="input" type="number" min={1} max={365} value={f.trialDays} onChange={set('trialDays')} /></div>
              <div><label className="field-label">Трафик, ГБ (0 = без лимита)</label><input className="input" type="number" min={0} value={f.trialGb} onChange={set('trialGb')} /></div>
              <div><label className="field-label">Устройств</label><input className="input" type="number" min={1} max={20} value={f.trialDevices} onChange={set('trialDevices')} /></div>
            </div>
            <div className="sub" style={{ fontSize: 12 }}>Новые значения применяются к пробным подпискам, выданным после сохранения.</div>
          </Section>

          <Section title="Защита">
            <div className="inset flex items-center justify-between gap-3" style={{ padding: 14 }}>
              <div><div style={{ fontWeight: 500 }}>Анти-абуз (HWID/IP)</div><div className="sub mt-0.5">Автобан подписки, если устройств (HWID) вдвое больше лимита тарифа (1 → 2, 2 → 4, 3 → 6…) или одновременно активных IP на нодах лимит+2 и больше (1 → 3, 2 → 4…) — по «Активным сессиям» Remnawave за последние 10 минут. Проверка раз в 10 минут. Первое нарушение — только предупреждение в бота, следующие 24 часа нарушения не учитываются; бан — если нарушение повторится позже (в течение 7 дней после предупреждения).</div></div>
              <Toggle on={antiabuse} onChange={() => setAntiabuse(!antiabuse)} />
            </div>
          </Section>

          <div><button className="btn solid" onClick={save} disabled={saving}>{saving ? <Spinner size={16} /> : <Save size={16} />} Сохранить</button></div>
        </div>
      )}
    </div>
  );
};
