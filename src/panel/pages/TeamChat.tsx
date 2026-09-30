import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, CornerUpLeft, Edit2, Save, Send, Trash2, Users, X } from 'lucide-react';
import { Spinner } from '../components/ui';
import { apiFetch, parseApiErr } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import type { ToastType } from '../lib/types';

type TQuote = { id: number; author: string; text: string; deleted: boolean };
type TMsg = { id: number; author: string; role: string; mine: boolean; text: string; deleted: boolean; edited?: boolean; reply_to: TQuote | null; created_at: string };

export const TEAM_CHAT_ID = 0;
const MAX = 4000;
const ROLE_RU: Record<string, string> = { owner: 'администратор', curator: 'куратор', operator: 'оператор' };
const pingUnread = () => window.dispatchEvent(new Event('support-unread'));

// чат сотрудников (юзеры не видят)
export const TeamChat: React.FC<{ onBack: () => void; onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onBack, onToast }) => {
  const [msgs, setMsgs] = useState<TMsg[] | null>(null);
  const [owner, setOwner] = useState(false);
  const [text, setText] = useState('');
  const [reply, setReply] = useState<TMsg | null>(null);
  const [editing, setEditing] = useState<TMsg | null>(null);
  const [busy, setBusy] = useState(false);
  const [older, setOlder] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const lastId = useRef(0);
  const stick = useRef(true);

  const markRead = (id: number) => { if (id > 0) apiFetch('/panel/team-chat/read', { method: 'POST', body: JSON.stringify({ last_id: id }) }).then(pingUnread).catch(() => {}); };

  useEffect(() => {
    let alive = true;
    apiFetch('/panel/team-chat').then((d) => {
      if (!alive) return;
      const list: TMsg[] = d.messages || [];
      setMsgs(list); setOwner(!!d.me?.owner); setOlder(list.length >= 100);
      lastId.current = list.length ? list[list.length - 1].id : 0;
      markRead(lastId.current);
    }).catch(() => setMsgs([]));
    const t = setInterval(() => {
      apiFetch(`/panel/team-chat?after=${lastId.current}`).then((d) => {
        if (!alive) return;
        const add: TMsg[] = d.messages || [];
        const gone = new Set<number>(Array.isArray(d.deleted) ? d.deleted : []);
        if (gone.size) setMsgs((cur) => (cur && cur.some((m) => gone.has(m.id) && !m.deleted)
          ? cur.map((m) => (gone.has(m.id) ? { ...m, deleted: true, text: '' } : m)) : cur));
        const ed = new Map<number, TMsg>((Array.isArray(d.edited) ? d.edited : []).map((m: TMsg) => [m.id, m]));
        if (ed.size) setMsgs((cur) => (cur && cur.some((m) => ed.has(m.id) && ed.get(m.id)!.text !== m.text)
          ? cur.map((m) => (ed.has(m.id) && !m.deleted ? { ...m, text: ed.get(m.id)!.text, edited: true } : m)) : cur));
        if (!add.length) return;
        lastId.current = add[add.length - 1].id;
        setMsgs((cur) => {
          const have = new Set((cur || []).map((m) => m.id));
          return [...(cur || []), ...add.filter((m) => !have.has(m.id))].sort((a, b) => a.id - b.id);
        });
        if (document.visibilityState === 'visible') markRead(lastId.current);
      }).catch(() => {});
    }, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const loadOlder = useCallback(async () => {
    if (!msgs || !msgs.length) return;
    const el = listRef.current; const h = el ? el.scrollHeight : 0;
    try {
      const d = await apiFetch(`/panel/team-chat?before=${msgs[0].id}`);
      const add: TMsg[] = d.messages || [];
      setOlder(add.length >= 100);
      stick.current = false;
      setMsgs((cur) => [...add, ...(cur || [])]);
      requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - h; });
    } catch { /* ignore */ }
  }, [msgs]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    if (editing) {
      try {
        const m: TMsg = await apiFetch(`/panel/team-chat/messages/${editing.id}/edit`, { method: 'POST', body: JSON.stringify({ text: t }) });
        setMsgs((cur) => (cur || []).map((x) => (x.id === m.id ? m : x)));
        setEditing(null); setText('');
      } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось изменить'), 'error'); } finally { setBusy(false); }
      return;
    }
    try {
      const m: TMsg = await apiFetch('/panel/team-chat/messages', { method: 'POST', body: JSON.stringify({ text: t, reply_to: reply?.id || null }) });
      stick.current = true;
      // lastId не двигаем: чужие сообщения до нашего подтянет опрос
      setMsgs((cur) => [...(cur || []).filter((x) => x.id !== m.id), m].sort((a, b) => a.id - b.id));
      setText(''); setReply(null);
    } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось отправить'), 'error'); } finally { setBusy(false); }
  };

  const remove = async (m: TMsg) => {
    if (!window.confirm('Удалить сообщение?')) return;
    try {
      await apiFetch(`/panel/team-chat/messages/${m.id}`, { method: 'DELETE' });
      setMsgs((cur) => (cur || []).map((x) => (x.id === m.id ? { ...x, deleted: true, text: '' } : x)));
    } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось удалить'), 'error'); }
  };

  return (
    <div className="card" style={{ padding: 0, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
      <div className="flex items-center gap-2" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <button className="icon-btn lg:!hidden" onClick={onBack} title="К списку"><ArrowLeft size={16} /></button>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>Чат сотрудников</div>
          <div className="sub" style={{ fontSize: 12 }}>Общий для администратора, кураторов и операторов · пользователи его не видят</div>
        </div>
      </div>

      <div ref={listRef} onScroll={() => { const el = listRef.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
        style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {msgs == null ? <div style={{ margin: 'auto' }}><Spinner /></div>
          : msgs.length === 0 ? (
            <div className="sub flex flex-col items-center" style={{ margin: 'auto', gap: 8, textAlign: 'center', fontSize: 13 }}>
              <Users size={30} className="faint" />Здесь пока тихо. Напишите коллегам первым.
            </div>
          ) : (<>
            {older && <button className="btn sm" style={{ alignSelf: 'center' }} onClick={() => void loadOlder()}>Показать раньше</button>}
            {msgs.map((m, i) => {
              const day = i === 0 || new Date(msgs[i - 1].created_at).toDateString() !== new Date(m.created_at).toDateString();
              const head = i === 0 || day || msgs[i - 1].author !== m.author || msgs[i - 1].mine !== m.mine;
              return (
                <React.Fragment key={m.id}>
                  {day && <div className="faint" style={{ alignSelf: 'center', fontSize: 11, margin: '6px 0' }}>{fmtDateTime(m.created_at).slice(0, 10)}</div>}
                  <div className="sup-msg" style={{ alignSelf: m.mine ? 'flex-end' : 'flex-start', maxWidth: '78%', display: 'flex', flexDirection: 'column', alignItems: m.mine ? 'flex-end' : 'flex-start' }}>
                    {head && !m.mine && <div className="sub" style={{ fontSize: 12, margin: '0 0 3px 4px' }}><b style={{ color: 'var(--text)' }}>{m.author}</b> · {ROLE_RU[m.role] || m.role}</div>}
                    <div className="flex items-end gap-2" style={{ flexDirection: m.mine ? 'row-reverse' : 'row', maxWidth: '100%' }}>
                      <div style={{
                        background: m.mine ? '#fff' : 'rgba(255,255,255,0.06)', color: m.mine ? '#000' : 'var(--text)', border: m.mine ? 'none' : '1px solid var(--border)',
                        borderRadius: 14, borderBottomRightRadius: m.mine ? 4 : 14, borderBottomLeftRadius: m.mine ? 14 : 4, padding: '8px 12px',
                        display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, maxWidth: '100%', opacity: m.deleted ? 0.55 : 1,
                      }}>
                        {m.reply_to && (
                          <div style={{ padding: '4px 8px', borderRadius: 8, borderLeft: `3px solid ${m.mine ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.4)'}`, background: m.mine ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.05)' }}>
                            <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.75 }}>{m.reply_to.author}</div>
                            <div style={{ fontSize: 12, opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }}>{m.reply_to.deleted ? 'Сообщение удалено' : m.reply_to.text}</div>
                          </div>
                        )}
                        <div style={{ fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontStyle: m.deleted ? 'italic' : undefined }}>{m.deleted ? 'Сообщение удалено' : m.text}</div>
                        <div style={{ alignSelf: 'flex-end', fontSize: 11, opacity: 0.55, marginTop: -2 }}>{m.edited ? 'изменено · ' : ''}{fmtDateTime(m.created_at).slice(11, 16)}</div>
                      </div>
                      {!m.deleted && (
                        <div className="sup-reply flex flex-col gap-1" style={{ flex: 'none' }}>
                          <button className="icon-btn" title="Ответить" style={{ width: 26, height: 26 }} onClick={() => { setEditing(null); setReply(m); }}><CornerUpLeft size={13} /></button>
                          {m.mine && <button className="icon-btn" title="Изменить" style={{ width: 26, height: 26 }} onClick={() => { setReply(null); setEditing(m); setText(m.text); }}><Edit2 size={13} /></button>}
                          {(m.mine || owner) && <button className="icon-btn" title="Удалить" style={{ width: 26, height: 26 }} onClick={() => void remove(m)}><Trash2 size={13} /></button>}
                        </div>
                      )}
                    </div>
                  </div>
                </React.Fragment>
              );
            })}
          </>)}
      </div>

      <div style={{ borderTop: '1px solid var(--border)', padding: 12 }}>
        {editing && (
          <div className="flex items-center gap-3" style={{ padding: '6px 10px', marginBottom: 8, borderLeft: '3px solid #ff8a3d', background: 'rgba(255,107,26,0.08)', borderRadius: 8 }}>
            <Edit2 size={15} style={{ color: '#ff8a3d', flex: 'none' }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#ff8a3d' }}>Редактирование</div>
              <div className="sub" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{editing.text}</div>
            </div>
            <button className="icon-btn" style={{ width: 26, height: 26 }} title="Отменить (Esc)" onClick={() => { setEditing(null); setText(''); }}><X size={13} /></button>
          </div>
        )}
        {reply && (
          <div className="flex items-center gap-3" style={{ padding: '6px 10px', marginBottom: 8, borderLeft: '3px solid #60a5fa', background: 'rgba(96,165,250,0.08)', borderRadius: 8 }}>
            <CornerUpLeft size={15} style={{ color: '#60a5fa', flex: 'none' }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#60a5fa' }}>Ответ {reply.author}</div>
              <div className="sub" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{reply.text}</div>
            </div>
            <button className="icon-btn" style={{ width: 26, height: 26 }} title="Отменить ответ" onClick={() => setReply(null)}><X size={13} /></button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea className="input" rows={1} value={text} placeholder="Сообщение коллегам… (Enter — отправить, Shift+Enter — новая строка)"
            onChange={(e) => { setText(e.target.value.slice(0, MAX)); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`; }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } if (e.key === 'Escape' && editing) { setEditing(null); setText(''); } }}
            style={{ flex: 1, resize: 'none', minHeight: 42, maxHeight: 160, lineHeight: 1.4, paddingTop: 10, paddingBottom: 10 }} />
          <button className="btn solid" style={{ height: 42, flex: 'none' }} disabled={!text.trim() || busy} onClick={() => void send()}>
            {busy ? <Spinner size={15} /> : editing ? <Save size={15} /> : <Send size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
};
