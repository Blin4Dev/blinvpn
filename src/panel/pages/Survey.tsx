import React, { useState, useEffect } from 'react';
import {
  CheckCircle, Send, BarChart2, FileText, ClipboardList, ArrowDown, ArrowUp, ChevronRight, Plus, Trash2, X,
} from 'lucide-react';
import { DCard, Modal, PageHead, Spinner, Stat } from '../components/ui';
import { apiFetch, parseApiErr, parseErr } from '../lib/api';
import { fmtInt } from '../lib/format';
import type { ToastType } from '../lib/types';

export type SurveyOption = { answer: string; count: number };

export type SurveyTextAnswer = { answer: string; user_id: number; username?: string | null; telegram_id?: number | null; created_at?: string | null };

export type SurveyQuestion = { n: number; q: string; kind: string; options?: SurveyOption[]; answers?: SurveyTextAnswer[] };

export type SurveyConfigQ = { n: number; kind: 'single' | 'multi' | 'text'; q: string; options: string[]; ask_text: string[] };

export type SurveyStats = { total_started: number; total_completed: number; total_invited: number; reward_percent: number; questions: SurveyQuestion[]; config: SurveyConfigQ[] };

const KIND_LABEL: Record<SurveyConfigQ['kind'], string> = { single: 'Один вариант', multi: 'Несколько вариантов', text: 'Свой ответ' };

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
  const [edit, setEdit] = useState<{ q: SurveyConfigQ; index: number } | null>(null);
  const [reward, setReward] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (stats) setReward(String(stats.reward_percent)); }, [stats]);

  const saveAll = async (questions: SurveyConfigQ[], rewardPct: number, msg = 'Сохранено'): Promise<boolean> => {
    setBusy(true);
    try {
      setStats(await apiFetch('/panel/surveys/questions', { method: 'PUT', body: JSON.stringify({ questions, reward_percent: rewardPct }) }));
      onToast(msg, '', 'success');
      return true;
    } catch (e) { onToast('Не сохранено', parseApiErr(e, 'Ошибка'), 'error'); return false; } finally { setBusy(false); }
  };

  useEffect(() => { (async () => {
    try { setStats(await apiFetch('/panel/surveys/stats')); }
    catch (e) { onToast('Ошибка', parseErr(e), 'error'); }
    finally { setLoading(false); }
  })(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  if (loading) return <div style={{ padding: 60, display: "flex", justifyContent: "center" }}><Spinner size={22} /></div>;
  if (!stats) return <div className="muted" style={{ padding: 20 }}>Нет данных.</div>;

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Опрос" sub="Управление и результаты автоматических опросов" />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Stat title="Приглашено" value={fmtInt(stats.total_invited)} icon={Send} />
        <Stat title="Начали" value={fmtInt(stats.total_started)} icon={ClipboardList} />
        <Stat title="Завершили" value={fmtInt(stats.total_completed)} icon={CheckCircle} sub={stats.total_started ? `${Math.round((stats.total_completed / stats.total_started) * 100)}% из начавших` : undefined} />
      </div>

      <div className="card" style={{ padding: 6 }}>
        <div className="flex items-center justify-between gap-3" style={{ padding: '10px 12px' }}>
          <span className="h-sec">Вопросы</span>
          <div className="flex items-center gap-2">
            <span className="sub" style={{ fontSize: 13 }}>Скидка, %</span>
            <input className="input" style={{ width: 70 }} type="number" min={0} max={50} value={reward} onChange={(e) => setReward(e.target.value.replace(/\D/g, '').slice(0, 2))} />
            {Number(reward) !== stats.reward_percent && reward !== '' && (
              <button className="btn sm solid" disabled={busy} onClick={() => void saveAll(stats.config, Number(reward))}>Сохранить</button>
            )}
            <button className="btn sm" disabled={busy || stats.config.length >= 20} onClick={() => setEdit({ q: { n: 0, kind: 'single', q: '', options: ['', ''], ask_text: [] }, index: -1 })}><Plus size={14} /> Вопрос</button>
          </div>
        </div>
        {stats.config.map((q, i) => (
          <button key={q.n} className="bal-row" onClick={() => setEdit({ q, index: i })}>
            <span className="faint mono" style={{ width: 22, textAlign: 'right', flex: 'none' }}>{i + 1}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.q}</span>
              <span className="faint" style={{ display: 'block', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {KIND_LABEL[q.kind]}{q.options.length ? ` · ${q.options.join(', ')}` : ''}
              </span>
            </span>
            <ChevronRight size={16} className="faint" style={{ flex: 'none' }} />
          </button>
        ))}
      </div>

      {edit && (
        <QuestionEditor initial={edit.q} index={edit.index} total={stats.config.length} busy={busy} onClose={() => setEdit(null)}
          onSave={async (q) => {
            const list = [...stats.config];
            if (edit.index < 0) list.push(q); else list[edit.index] = q;
            if (await saveAll(list, stats.reward_percent)) setEdit(null);
          }}
          onDelete={async () => {
            if (!window.confirm('Удалить вопрос? Его ответы пропадут из результатов.')) return;
            if (await saveAll(stats.config.filter((_, j) => j !== edit.index), stats.reward_percent, 'Удалено')) setEdit(null);
          }}
          onMove={async (d) => {
            const list = [...stats.config]; const j = edit.index + d;
            if (j < 0 || j >= list.length) return;
            [list[edit.index], list[j]] = [list[j], list[edit.index]];
            if (await saveAll(list, stats.reward_percent, 'Порядок изменён')) setEdit({ q: list[j], index: j });
          }} />
      )}

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

/** Окно вопроса: текст, тип, варианты (с уточнением текстом для «Другое»). */
const QuestionEditor: React.FC<{
  initial: SurveyConfigQ; index: number; total: number; busy: boolean;
  onClose: () => void; onSave: (q: SurveyConfigQ) => void; onDelete: () => void; onMove: (d: -1 | 1) => void;
}> = ({ initial, index, total, busy, onClose, onSave, onDelete, onMove }) => {
  const [q, setQ] = useState<SurveyConfigQ>({ ...initial, options: initial.options.length ? [...initial.options] : ['', ''] });
  const [err, setErr] = useState('');
  const isNew = index < 0;
  const setOpt = (i: number, v: string) => {
    const old = q.options[i];
    const options = q.options.map((o, j) => (j === i ? v : o));
    setQ({ ...q, options, ask_text: q.ask_text.map((a) => (a === old ? v : a)) });
  };
  const done = () => {
    const text = q.q.trim();
    const options = q.kind === 'text' ? [] : q.options.map((o) => o.trim()).filter(Boolean);
    if (!text) return setErr('Напишите вопрос');
    if (q.kind !== 'text' && options.length < 2) return setErr('Нужно хотя бы 2 варианта');
    if (new Set(options).size !== options.length) return setErr('Варианты повторяются');
    return onSave({ ...q, q: text, options, ask_text: q.kind === 'single' ? q.ask_text.filter((a) => options.includes(a)) : [] });
  };
  return (
    <Modal onClose={onClose} width={520} title={isNew ? 'Новый вопрос' : `Вопрос ${index + 1}`}
      footer={<>
        <div className="flex gap-1" style={{ flex: 1 }}>
          {!isNew && <>
            <button className="icon-btn danger" disabled={busy} onClick={onDelete} title="Удалить" aria-label="Удалить"><Trash2 size={15} /></button>
            <button className="icon-btn" disabled={busy || index === 0} onClick={() => onMove(-1)} title="Выше" aria-label="Выше"><ArrowUp size={15} /></button>
            <button className="icon-btn" disabled={busy || index === total - 1} onClick={() => onMove(1)} title="Ниже" aria-label="Ниже"><ArrowDown size={15} /></button>
          </>}
        </div>
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn solid" disabled={busy} onClick={done}>{busy ? <Spinner size={15} /> : null} {isNew ? 'Добавить' : 'Сохранить'}</button>
      </>}>
      <div className="flex flex-col gap-4">
        <div>
          <label className="field-label">Вопрос</label>
          <textarea className="input" rows={2} maxLength={300} value={q.q} autoFocus={isNew} onChange={(e) => { setErr(''); setQ({ ...q, q: e.target.value }); }} />
        </div>
        <div>
          <label className="field-label">Ответ</label>
          <select className="input" value={q.kind} onChange={(e) => setQ({ ...q, kind: e.target.value as SurveyConfigQ['kind'] })}>
            <option value="single">Один вариант</option>
            <option value="multi">Несколько вариантов</option>
            <option value="text">Свой ответ текстом</option>
          </select>
        </div>
        {q.kind !== 'text' && (
          <div className="flex flex-col gap-2">
            <label className="field-label" style={{ margin: 0 }}>Варианты</label>
            {q.options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <input className="input" maxLength={60} value={o} placeholder={`Вариант ${i + 1}`} onChange={(e) => { setErr(''); setOpt(i, e.target.value); }} />
                {q.kind === 'single' && (
                  <label className="flex items-center gap-1 sub" style={{ fontSize: 12, whiteSpace: 'nowrap', cursor: 'pointer' }} title="После выбора попросить написать текст">
                    <input type="checkbox" style={{ accentColor: 'var(--accent)' }} checked={q.ask_text.includes(o) && !!o}
                      onChange={(e) => setQ({ ...q, ask_text: e.target.checked ? [...q.ask_text, o] : q.ask_text.filter((a) => a !== o) })} /> + текст
                  </label>
                )}
                <button className="icon-btn" disabled={q.options.length <= 2} onClick={() => setQ({ ...q, options: q.options.filter((_, j) => j !== i), ask_text: q.ask_text.filter((a) => a !== o) })} aria-label="Убрать"><X size={14} /></button>
              </div>
            ))}
            {q.options.length < 10 && <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setQ({ ...q, options: [...q.options, ''] })}><Plus size={14} /> Вариант</button>}
          </div>
        )}
        {err && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</div>}
      </div>
    </Modal>
  );
};
