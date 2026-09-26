import React, { useState } from 'react';
import {
  DollarSign, Zap, Send, Cloud, FileText, Shield,
} from 'lucide-react';
import type { ToastType } from '../../lib/types';
import { BackupSettingsTab } from './BackupsTab';
import { ForumSettingsTab } from './ForumTab';
import { LegalSettingsTab } from './LegalTab';
import { PricesSettingsTab } from './PricesTab';
import { SquadsPage } from './SquadsTab';

type Tab = 'prices' | 'offer' | 'privacy' | 'squads' | 'backups' | 'forum';

export const SettingsPage: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void; tab?: Tab; onTab?: (t: Tab) => void }> = ({ onToast, tab, onTab }) => {
  // Вкладка хранится в адресе (/settings/forum и т.п.), если её передали сверху
  const [ownTab, setOwnTab] = useState<Tab>('prices');
  const activeTab = tab ?? ownTab;
  const setActiveTab = (t: Tab) => { if (onTab) onTab(t); else setOwnTab(t); };
  const tabs = [
    { id: 'prices', icon: DollarSign, label: 'Цены' },
    { id: 'offer', icon: FileText, label: 'Оферта' },
    { id: 'privacy', icon: Shield, label: 'Конфиденциальность' },
    { id: 'squads', icon: Zap, label: 'Сквады' },
    { id: 'forum', icon: Send, label: 'Форум' },
    { id: 'backups', icon: Cloud, label: 'Резервные копии' },
  ] as const;

  return (
    <div className="flex flex-col lg:flex-row gap-6">
      <div style={{ width: 220, flex: 'none' }} className="w-full lg:!w-[220px]">
        <div className="card" style={{ position: 'sticky', top: 80, overflow: 'hidden' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}><span className="h-sec">Категории</span></div>
          <div style={{ padding: 8 }} className="flex flex-col gap-1">
            {tabs.map((t) => (
              <button key={t.id} className={`nav-item ${activeTab === t.id ? 'on' : ''}`} onClick={() => setActiveTab(t.id)}><t.icon size={16} className={activeTab === t.id ? '' : 'faint'} /> {t.label}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex-1">
        {activeTab === 'prices' && <PricesSettingsTab onToast={onToast} />}
        {activeTab === 'offer' && <LegalSettingsTab kind="offer" title="Договор оферты" onToast={onToast} />}
        {activeTab === 'privacy' && <LegalSettingsTab kind="privacy" title="Политика конфиденциальности" onToast={onToast} />}
        {activeTab === 'squads' && <SquadsPage onToast={onToast} />}
        {activeTab === 'forum' && <ForumSettingsTab onToast={onToast} />}
        {activeTab === 'backups' && <BackupSettingsTab onToast={onToast} />}
      </div>
    </div>
  );
};
