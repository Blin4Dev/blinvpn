import React from 'react';
import {
  DollarSign, Zap, Send, Cloud, FileText, Shield, ShieldAlert, Database, Mail,
} from 'lucide-react';
import type { ToastType } from '../../lib/types';
import { AntiAbuseSettingsTab } from './AntiAbuseTab';
import { BackupSettingsTab } from './BackupsTab';
import { ForumSettingsTab } from './ForumTab';
import { LegalSettingsTab } from './LegalTab';
import { MailSettingsTab } from './MailTab';
import { PricesSettingsTab } from './PricesTab';
import { SquadsPage } from './SquadsTab';
import { StorageSettingsTab } from './StorageTab';

export type Tab = 'price' | 'antiabuse' | 'offer' | 'privacy' | 'squads' | 'mail' | 'backups' | 'forum' | 'storage';

// разделы настроек (подменю в сайдбаре)
export const SETTINGS_SECTIONS: { id: Tab; icon: React.ElementType; label: string }[] = [
  { id: 'price', icon: DollarSign, label: 'Цены' },
  { id: 'antiabuse', icon: ShieldAlert, label: 'Анти-абуз' },
  { id: 'offer', icon: FileText, label: 'Оферта' },
  { id: 'privacy', icon: Shield, label: 'Конфиденциальность' },
  { id: 'squads', icon: Zap, label: 'Сквады' },
  { id: 'mail', icon: Mail, label: 'Почта' },
  { id: 'forum', icon: Send, label: 'Уведомления' },
  { id: 'backups', icon: Cloud, label: 'Резервные копии' },
  { id: 'storage', icon: Database, label: 'Хранилище S3' },
];

export const SettingsPage: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void; tab: Tab; onTab?: (t: Tab) => void }> = ({ onToast, tab }) => (
  <div style={{ maxWidth: 980 }}>
    {tab === 'price' && <PricesSettingsTab onToast={onToast} />}
    {tab === 'antiabuse' && <AntiAbuseSettingsTab onToast={onToast} />}
    {tab === 'offer' && <LegalSettingsTab kind="offer" title="Договор оферты" onToast={onToast} />}
    {tab === 'privacy' && <LegalSettingsTab kind="privacy" title="Политика конфиденциальности" onToast={onToast} />}
    {tab === 'squads' && <SquadsPage onToast={onToast} />}
    {tab === 'mail' && <MailSettingsTab onToast={onToast} />}
    {tab === 'forum' && <ForumSettingsTab onToast={onToast} />}
    {tab === 'backups' && <BackupSettingsTab onToast={onToast} />}
    {tab === 'storage' && <StorageSettingsTab onToast={onToast} />}
  </div>
);
