import React from 'react';
import type { ToastType } from '../../lib/types';
import { MonOverview } from './NodeList';
import { MonNodePage } from './NodePage';

export const MonitoringPage: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void; nodeId: number | null; setNodeId: (id: number | null) => void }> =
  ({ onToast, nodeId, setNodeId }) => {
    if (nodeId != null) return <MonNodePage nodeId={nodeId} onBack={() => setNodeId(null)} onToast={onToast} />;
    return <MonOverview onToast={onToast} onOpen={setNodeId} />;
  };
