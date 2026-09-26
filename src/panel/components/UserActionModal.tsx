import React, { useState } from 'react';
import {
  Mail, Percent, Settings, CheckCircle, ArrowUpRight, ArrowDownLeft, Calendar, Ban, Clock, Edit2, Smartphone, Database, Wallet, Plus, Send, RefreshCw,
} from 'lucide-react';
import { Modal, Toggle } from './ui';

export const DEVICE_LIMIT_PRESETS = [1, 2, 3, 5, 10, 15, 20];

export const clampNumber = (raw: string, min: number, max: number, fallback: number) => {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

export type ActionConfig = { title: string; label: string; icon: React.ElementType; type: string; min?: number; max?: number; presets?: number[]; };

export const ACTION_MAP: Record<string, ActionConfig> = {
  ADD_BALANCE:        { title: 'Начислить баланс', label: 'Сумма, ₽', icon: ArrowUpRight, type: 'number' },
  SUB_BALANCE:        { title: 'Списать баланс', label: 'Сумма, ₽', icon: ArrowDownLeft, type: 'number' },
  EXTEND_SUB:         { title: 'Продлить подписку', label: 'Дней', icon: Clock, type: 'number' },
  REDUCE_SUB:         { title: 'Уменьшить срок', label: 'Дней', icon: Clock, type: 'number' },
  SET_TRAFFIC:        { title: 'Лимит трафика', label: 'Макс. трафик, ГБ', icon: Database, type: 'number' },
  SET_DEVICES:        { title: 'Лимит устройств', label: 'Устройств (1–20)', icon: Smartphone, type: 'number', min: 1, max: 20, presets: DEVICE_LIMIT_PRESETS },
  BAN:                { title: 'Заблокировать', label: 'Причина', icon: Ban, type: 'text' },
  UNBAN:              { title: 'Разблокировать', label: '', icon: CheckCircle, type: 'text' },
  MASS_ADD_DAYS:      { title: 'Добавить дни всем активным', label: 'Дней (только действующим подпискам)', icon: Calendar, type: 'number', min: 1, max: 365 },
  MASS_RESET_TRIAL:   { title: 'Сбросить пробный период', label: '', icon: RefreshCw, type: 'text' },
  MASS_RESET_TRAFFIC: { title: 'Сбросить трафик всем', label: '', icon: Database, type: 'text' },
  SET_PARTNER_RATE:   { title: 'Процент реферала', label: 'Процент, %', icon: Percent, type: 'number', min: 0, max: 100 },
  SET_PARTNER_BALANCE:{ title: 'Реферальный баланс', label: 'Сумма, ₽', icon: Wallet, type: 'number' },
  ADD_PARTNER_BALANCE:{ title: 'Начислить на реф-баланс', label: 'Сумма, ₽', icon: Plus, type: 'number' },
  SUB_PARTNER_BALANCE:{ title: 'Списать с реф-баланса', label: 'Сумма, ₽', icon: ArrowDownLeft, type: 'number' },
  ADD_TRAFFIC:        { title: 'Добавить трафик', label: 'ГБ', icon: Database, type: 'number' },
  SUB_TRAFFIC:        { title: 'Убавить трафик', label: 'ГБ', icon: Database, type: 'number' },
  SET_TELEGRAM_ID:    { title: 'Изменить Telegram ID', label: 'Новый Telegram ID', icon: Edit2, type: 'number' },
  SET_EMAIL:          { title: 'Изменить email', label: 'Новый email', icon: Mail, type: 'text' },
  NOTIFY:             { title: 'Написать пользователю', label: 'Сообщение', icon: Send, type: 'text' },
};

export const UserActionModal: React.FC<{
  type: string; onClose: () => void; onConfirm: (value: string, notify: boolean) => void; initialValue?: string;
}> = ({ type, onClose, onConfirm, initialValue = '' }) => {
  const [value, setValue] = useState(initialValue);
  const [notify, setNotify] = useState(true);
  const config = ACTION_MAP[type] || { title: 'Действие', label: 'Значение', icon: Settings, type: 'text' };
  const numMin = config.min ?? 0;
  const numMax = config.max ?? 999999;
  const numValue = config.type === 'number' ? clampNumber(value, numMin, numMax, numMin || 0) : 0;
  const showStepper = config.type === 'number' && (!!config.presets?.length || config.max !== undefined);
  const setNum = (n: number) => setValue(String(Math.max(numMin, Math.min(numMax, n))));
  const isDestructive = /BAN|DELETE|REMOVE|SUB_/.test(type);

  return (
    <Modal
      onClose={onClose} title={config.title} icon={config.icon} width={400} z={70}
      footer={
        <>
          <button className="btn block" onClick={onClose}>Отмена</button>
          <button
            className={`btn block ${isDestructive ? 'danger' : 'solid'}`}
            onClick={() => onConfirm(config.type === 'number' ? String(clampNumber(value, numMin, numMax, numMin || 0)) : value, notify)}
          >Применить</button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {config.label && (
          <div>
            <label className="field-label">{config.label}</label>
            {showStepper ? (
              <div className="flex flex-col gap-3">
                <div className="stepper">
                  <button className="step" onClick={() => setNum(numValue - 1)} disabled={numValue <= numMin}>−</button>
                  <input className="input center mono" style={{ fontSize: 20 }} type="number" value={value}
                    min={numMin} max={numMax} autoFocus onChange={(e) => setValue(e.target.value)} />
                  <button className="step" onClick={() => setNum(numValue + 1)} disabled={numValue >= numMax}>+</button>
                </div>
                {config.presets && (
                  <div className="flex flex-wrap gap-2">
                    {config.presets.map((p) => (
                      <button key={p} className={`chip mono ${numValue === p ? 'on' : ''}`} onClick={() => setNum(p)}>{p}</button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <input className="input mono" type={config.type} value={value} placeholder={config.type === 'number' ? '0' : ''}
                autoFocus min={numMin} max={config.max} onChange={(e) => setValue(e.target.value)} />
            )}
          </div>
        )}
        {type.startsWith('MASS_') ? (
          <div className="sub" style={{ fontSize: 12 }}>
            {type === 'MASS_ADD_DAYS' && 'Продлеваются только действующие подписки — и в базе, и в Remnawave. Выполняется в фоне.'}
            {type === 'MASS_RESET_TRAFFIC' && 'Счётчик трафика обнулится у всех пользователей в Remnawave.'}
            {type === 'MASS_RESET_TRIAL' && 'Все, у кого пробный период уже закончился, смогут взять его снова. Действующие пробные не трогаются.'}
          </div>
        ) : (
          <label className="inset flex items-center justify-between gap-3" style={{ padding: 12, cursor: 'pointer' }}>
            <div>
              <div style={{ fontWeight: 500 }}>Уведомить пользователя</div>
              <div className="sub">Отправить сообщение в бот</div>
            </div>
            <Toggle on={notify} onChange={() => setNotify(!notify)} />
          </label>
        )}
      </div>
    </Modal>
  );
};
