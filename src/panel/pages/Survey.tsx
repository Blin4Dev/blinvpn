import React, { useState, useEffect } from 'react';
import {
  CheckCircle, Send, BarChart2, FileText, ClipboardList,
} from 'lucide-react';
import { DCard, PageHead, Spinner, Stat } from '../components/ui';
import { apiFetch, parseErr } from '../lib/api';
import { fmtInt } from '../lib/format';
import type { ToastType } from '../lib/types';

export type SurveyOption = { answer: string; count: number };

export type SurveyTextAnswer = { answer: string; user_id: number; username?: string | null; telegram_id?: number | null; created_at?: string | null };

export type SurveyQuestion = { n: number; q: string; kind: string; options?: SurveyOption[]; answers?: SurveyTextAnswer[] };

export type SurveyStats = { total_started: number; total_completed: number; total_invited: number; reward_percent: number; questions: SurveyQuestion[] };

export const SurveyBar: React.FC<{ label: string; count: number; max: number; total: number }> = ({ label, count, max, total }) => {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const width = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div style={{ padding: '7px 0' }}>
      <div className="flex items-center justify-between gap-3" style={{ marginBottom: 4 }}>
        <span className="sub" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span className="mono" style={{ whiteSpace: 'nowrap' }}>{count} <span className="faint" style={{ fontSize: 12 }}>· {pct}%</span></span>
      </div>
      <div style={{ height: 8, borderRadius: 6, background: 'var(--border)', overflow: 'hidden' }}>
        <div style={{ width: `${width}%`, height: '100%', background: 'var(--accent, #10b981)', borderRadius: 6 }} />
      </div>
    </div>
  );
};

export const SurveyPage: React.FC<{ onToast: (t: string, m: string, ty?: ToastType) => void; onOpenUser: (id: number) => void }> = ({ onToast, onOpenUser }) => {
  const [stats, setStats] = useState<SurveyStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { (async () => {
    try { setStats(await apiFetch('/panel/surveys/stats')); }
    catch (e) { onToast('Ошибка', parseErr(e), 'error'); }
    finally { setLoading(false); }
  })(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  if (loading) return <div style={{ padding: 60, display: "flex", justifyContent: "center" }}><Spinner size={22} /></div>;
  if (!stats) return <div className="muted" style={{ padding: 20 }}>Нет данных.</div>;

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Опрос" sub={`Награда за прохождение — скидка ${stats.reward_percent}% (суммируется с другими)`} />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Stat title="Приглашено" value={fmtInt(stats.total_invited)} icon={Send} />
        <Stat title="Начали" value={fmtInt(stats.total_started)} icon={ClipboardList} />
        <Stat title="Завершили" value={fmtInt(stats.total_completed)} icon={CheckCircle} sub={stats.total_started ? `${Math.round((stats.total_completed / stats.total_started) * 100)}% из начавших` : undefined} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {stats.questions.map((q) => (
          <DCard key={q.n} title={`${q.n}. ${q.q}`} icon={q.kind === 'text' ? FileText : BarChart2}>
            {q.kind === 'text' ? (
              (q.answers && q.answers.length > 0) ? (
                <div className="flex flex-col gap-2" style={{ maxHeight: 320, overflowY: 'auto' }}>
                  {q.answers.map((a, i) => (
                    <div key={i} className="inset" style={{ padding: '8px 10px' }}>
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{a.answer}</div>
                      <button className="sub" style={{ marginTop: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent, #10b981)' }}
                        onClick={() => onOpenUser(a.user_id)}>
                        {a.username ? `@${a.username}` : (a.telegram_id ? `id${a.telegram_id}` : `#${a.user_id}`)}
                      </button>
                    </div>
                  ))}
                </div>
              ) : <div className="muted sm">Пока нет ответов.</div>
            ) : (
              (q.options && q.options.length > 0) ? (
                <div>
                  {(() => { const max = Math.max(...q.options!.map((o) => o.count), 1); return q.options!.map((o) => (
                    <SurveyBar key={o.answer} label={o.answer} count={o.count} max={max} total={stats.total_completed} />
                  )); })()}
                </div>
              ) : <div className="muted sm">Пока нет ответов.</div>
            )}
          </DCard>
        ))}
      </div>
    </div>
  );
};
