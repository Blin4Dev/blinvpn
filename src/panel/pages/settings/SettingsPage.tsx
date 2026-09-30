import React from 'react';
import {
  DollarSign, Zap, Send, Cloud, FileText, Shield, Database, Shuffle, Mail,
} from 'lucide-react';
import type { ToastType } from '../../lib/types';
import { BackupSettingsTab } from './BackupsTab';
import { ForumSettingsTab } from './ForumTab';
import { LegalSettingsTab } from './LegalTab';
import { MailSettingsTab } from './MailTab';
import { PricesSettingsTab } from './PricesTab';
import { SquadsPage } from './SquadsTab';
import { StorageSettingsTab } from './StorageTab';
import { XbmSettingsTab } from './XbmTab';

export type Tab = 'prices' | 'offer' | 'privacy' | 'squads' | 'xbm' | 'mail' | 'backups' | 'forum' | 'storage';

/** Разделы настроек — показываются подменю «Настройки» в боковом меню. */
export const SETTINGS_SECTIONS: { id: Tab; icon: React.ElementType; label: string }[] = [
  { id: 'prices', icon: DollarSign, label: 'Цены' },
  { id: 'offer', icon: FileText, label: 'Оферта' },
  { id: 'privacy', icon: Shield, label: 'Конфиденциальность' },
  { id: 'squads', icon: Zap, label: 'Сквады' },
  { id: 'xbm', icon: Shuffle, label: 'XBM' },
  { id: 'mail', icon: Mail, label: 'Почта' },
  { id: 'forum', icon: Send, label: 'Форум' },
  { id: 'backups', icon: Cloud, label: 'Резервные копии' },
  { id: 'storage', icon: Database, label: 'Хранилище S3' },
];

export const SettingsPage: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void; tab: Tab; onTab?: (t: Tab) => void }> = ({ onToast, tab }) => (
  <div style={{ maxWidth: 980 }}>
    {tab === 'prices' && <PricesSettingsTab onToast={onToast} />}
    {tab === 'offer' && <LegalSettingsTab kind="offer" title="Договор оферты" onToast={onToast} />}
    {tab === 'privacy' && <LegalSettingsTab kind="privacy" title="Политика конфиденциальности" onToast={onToast} />}
    {tab === 'squads' && <SquadsPage onToast={onToast} />}
    {tab === 'xbm' && <XbmSettingsTab onToast={onToast} />}
    {tab === 'mail' && <MailSettingsTab onToast={onToast} />}
    {tab === 'forum' && <ForumSettingsTab onToast={onToast} />}
    {tab === 'backups' && <BackupSettingsTab onToast={onToast} />}
    {tab === 'storage' && <StorageSettingsTab onToast={onToast} />}
  </div>
);
