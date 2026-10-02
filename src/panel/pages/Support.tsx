import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle, Users, Trash2, CornerUpLeft, Download, Edit2, ExternalLink, FileText, FileX, HelpCircle, Info, Lock, MessageCircle, Paperclip, Play, Save, Search, Send, ShieldAlert, Undo2, X, XCircle } from 'lucide-react';
import { DotsMenu, Modal, Spinner } from '../components/ui';
import { RichText } from '../components/RichText';
import { TEAM_CHAT_ID, TeamChat } from './TeamChat';
import { apiFetch, getPanelToken, mergeInfo, parseApiErr } from '../lib/api';
import { fmtDateTime, fmtMoney } from '../lib/format';
import type { ToastType } from '../lib/types';

type SFile = { id: string; kind: 'image' | 'video' | 'file' | 'deleted'; name: string; size: number; url: string };
type SQuote = { id: number; sender?: string; text?: string; files?: number; deleted?: boolean };
type SMsg = {
  id: number; ticket_id?: number | null; sender: 'user' | 'admin' | 'system'; author?: string | null; text: string; created_at: string; files: SFile[]; reply_to?: SQuote | null;
  kind?: 'close_prompt' | null; action_active?: boolean | null; internal?: boolean; panel_text?: string | null;
  mine?: boolean; edited?: boolean; deleted?: boolean;
};
const EDIT_WINDOW_MS = 48 * 3600 * 1000;
// своё сообщение ещё можно править/удалить (48ч)
const canEditMsg = (m: SMsg) => !!m.mine && !m.deleted && !m.kind && m.sender === 'admin'
  && Date.now() - new Date(m.created_at).getTime() < EDIT_WINDOW_MS;
type Ticket = {
  id: number; number: number; status: 'open' | 'closed'; opened_at?: string; closed_at?: string | null; closed_by?: string | null;
  assigned_name?: string | null; assigned_to_me?: boolean; close_prompt?: boolean; prompt_at?: string | null;
  escalated?: boolean; escalate_note?: string | null;
  holder_role?: 'owner' | 'curator' | 'operator' | null; can_takeover?: boolean;
};
type Tab = 'open' | 'mine' | 'work' | 'archive';
const TAB_RU: Record<Tab, string> = { open: 'Открытые', mine: 'Мои', work: 'В работе', archive: 'Архив' };
const TAB_EMPTY: Record<Tab, string> = { open: 'Новых обращений нет', mine: 'У вас нет обращений в работе', work: 'Обращений в работе нет', archive: 'Архив пуст' };
type ChatRow = {
  id: number; user_id: number; user_label: string; user_name?: string | null; is_banned: boolean; status?: string | null;
  last_message_at?: string | null; last_preview?: string | null; last_sender?: string | null; unread: number;
  ticket?: Ticket | null; tab?: Tab; group?: '' | 'mine' | 'others' | 'escalated';
};
type MeInfo = { name: string; role: 'owner' | 'curator' | 'operator'; full: boolean; can_manage_user: boolean; prompt_ttl_min: number };
type ChatData = { chat: ChatRow & { started_by_me: boolean }; messages: SMsg[]; changes?: SMsg[]; limits: { max_file_mb: number; max_files: number; max_text: number }; me: MeInfo };
type Pending = { key: string; file: File; preview?: string; progress: number; id?: string; error?: string; abort?: () => void };

const POLL_MS = 4000;
const STATUS_RU: Record<string, string> = {
  active: 'Подписка активна', trial: 'Пробный период', expired: 'Подписка закончилась', lapsed: 'Подписка удалена',
  never: 'Без подписки', banned: 'Заблокирован', blocked: 'Ключ заблокирован',
};

// «только что» / «n мин назад» / дата
const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return fmtDateTime(iso).slice(0, 16);
};
const pingUnread = () => window.dispatchEvent(new Event('support-unread'));

const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : n >= 1024 ? `${Math.round(n / 1024)} КБ` : `${n} Б`);
const hm = (iso: string) => fmtDateTime(iso).slice(11, 16);
const hms = (iso: string) => fmtDateTime(iso).slice(11, 19);
const shortWhen = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? hm(iso) : fmtDateTime(iso).slice(0, 5);
};

function uploadFile(chatId: number, file: File, onProgress: (p: number) => void) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ id: string }>((resolve, reject) => {
    xhr.open('POST', `/api/panel/support/chats/${chatId}/upload?name=${encodeURIComponent(file.name || 'file')}`);
    xhr.setRequestHeader('Authorization', `Bearer ${getPanelToken()}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let b: any = null; try { b = JSON.parse(xhr.responseText); } catch { /* */ }
      if (xhr.status < 300 && b?.id) resolve(b); else reject(new Error(b?.detail?.message || `Ошибка ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Нет соединения'));
    xhr.onabort = () => reject(new Error('Отменено'));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

const Attachment: React.FC<{ f: SFile; mine: boolean; onImage: (u: string) => void; onMedia?: () => void }> = ({ f, mine, onImage, onMedia }) => {
  if (f.kind === 'deleted') return (
    <div className="flex items-center gap-2" style={{ padding: '8px 10px', borderRadius: 10, background: mine ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.04)', opacity: 0.75, minWidth: 200 }}>
      <FileX size={17} style={{ flex: 'none' }} />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, textDecoration: 'line-through', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
        <span style={{ display: 'block', fontSize: 11 }}>файл удалён — хранилище было заполнено</span>
      </span>
    </div>
  );
  if (f.kind === 'image') return <img src={f.url} alt={f.name} onLoad={onMedia} onClick={() => onImage(f.url)} style={{ display: 'block', maxWidth: 320, maxHeight: 260, width: '100%', objectFit: 'cover', borderRadius: 10, cursor: 'zoom-in' }} />;
  if (f.kind === 'video') return <video src={f.url} controls preload="metadata" onLoadedMetadata={onMedia} style={{ display: 'block', width: 340, maxWidth: '100%', maxHeight: 260, borderRadius: 10, background: '#000' }} />;
  return (
    <a href={f.url} download={f.name} className="flex items-center gap-2" style={{ padding: '8px 10px', borderRadius: 10, background: mine ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.06)', color: 'inherit', textDecoration: 'none', minWidth: 200 }}>
      <FileText size={18} style={{ flex: 'none', opacity: 0.8 }} />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
        <span style={{ display: 'block', fontSize: 11, opacity: 0.7 }}>{fmtSize(f.size)}</span>
      </span>
      <Download size={15} style={{ flex: 'none', opacity: 0.7 }} />
    </a>
  );
};

const quoteText = (q: SQuote) => (q.deleted ? 'Сообщение недоступно' : q.text || (q.files ? `📎 ${q.files === 1 ? 'Вложение' : `${q.files} влож.`}` : ''));

const Bubble: React.FC<{ m: SMsg; onImage: (u: string) => void; onMedia?: () => void; onReply?: (m: SMsg) => void; onQuote: (id: number) => void; flash: boolean;
  onEdit?: (m: SMsg) => void; onDelete?: (m: SMsg) => void }> =
  ({ m, onImage, onMedia, onReply, onQuote, flash, onEdit, onDelete }) => {
  if (m.sender === 'system' || (m.kind === 'close_prompt' && m.panel_text)) {
    // служебные события одной серой строкой, без времени
    const text = m.panel_text ?? m.text;
    if (!text) return null;
    return (
      <div data-mid={m.id} className="flex items-center gap-3" style={{ margin: '8px 0' }}>
        <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted, #9a9a9a)', textAlign: 'center' }}>{text}</span>
        <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      </div>
    );
  }
  const note = !!m.internal;
  const mine = m.sender === 'admin' && !note;
  if (m.deleted) {
    return (
      <div data-mid={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '78%' }}>
        <div style={{ border: '1px dashed var(--border-strong)', borderRadius: 14, padding: '7px 12px', fontSize: 13, fontStyle: 'italic' }} className="faint">
          {note ? 'Комментарий удалён' : 'Сообщение удалено'}{m.author ? ` · ${m.author}` : ''} · {hms(m.created_at)}
        </div>
      </div>
    );
  }
  const own = canEditMsg(m);
  // комментарий: тихая заметка слева, без оранжевого крика
  if (note) {
    return (
      <div data-mid={m.id} className="sup-msg" style={{ alignSelf: 'flex-start', maxWidth: '85%', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
        <div className="flex items-end gap-2" style={{ maxWidth: '100%' }}>
          <div style={{
            background: 'rgba(255,255,255,0.03)', color: 'var(--text)',
            border: '1px dashed var(--border-strong)', borderRadius: 12,
            padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4, maxWidth: '100%', minWidth: 0,
            boxShadow: flash ? '0 0 0 3px rgba(96,165,250,0.7)' : 'none', transition: 'box-shadow 0.3s',
          }}>
            <div className="faint" style={{ fontSize: 11, fontWeight: 500 }}>
              Комментарий{m.author ? ` · ${m.author}` : ''}
            </div>
            {m.reply_to && (
              <button onClick={() => onQuote(m.reply_to!.id)} title="Перейти к сообщению"
                style={{ textAlign: 'left', border: 'none', cursor: 'pointer', font: 'inherit', color: 'inherit', padding: '3px 6px', borderRadius: 6,
                  borderLeft: '2px solid var(--border-strong)', background: 'rgba(255,255,255,0.04)', marginTop: 2 }}>
                <div style={{ fontSize: 12, opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>{quoteText(m.reply_to)}</div>
              </button>
            )}
            {m.text && <div style={{ fontSize: 13, lineHeight: 1.45, wordBreak: 'break-word', opacity: 0.9 }}><RichText text={m.text} tone="chat" /></div>}
            <div className="faint" style={{ alignSelf: 'flex-end', fontSize: 11 }}>{m.edited ? 'изменено · ' : ''}{hms(m.created_at)}</div>
          </div>
          <div className="sup-reply flex flex-col gap-1" style={{ flex: 'none' }}>
            {onReply && <button className="icon-btn" title="Ответить" onClick={() => onReply(m)} style={{ width: 28, height: 28 }}><CornerUpLeft size={14} /></button>}
            {own && onEdit && <button className="icon-btn" title="Изменить" onClick={() => onEdit(m)} style={{ width: 28, height: 28 }}><Edit2 size={13} /></button>}
            {own && onDelete && <button className="icon-btn" title="Удалить комментарий" onClick={() => onDelete(m)} style={{ width: 28, height: 28 }}><Trash2 size={13} /></button>}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div data-mid={m.id} className="sup-msg" style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '78%', display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start' }}>
      <div className="flex items-end gap-2" style={{ flexDirection: mine ? 'row-reverse' : 'row', maxWidth: '100%' }}>
        <div style={{
          background: mine ? '#fff' : 'var(--surface-2, rgba(255,255,255,0.06))', color: mine ? '#000' : 'var(--text)',
          border: mine ? 'none' : '1px solid var(--border)', borderRadius: 14, borderBottomRightRadius: mine ? 4 : 14, borderBottomLeftRadius: mine ? 14 : 4,
          padding: m.files.length && !m.text && !m.reply_to ? 4 : '8px 12px', display: 'flex', flexDirection: 'column', gap: 6, maxWidth: '100%', minWidth: 0,
          boxShadow: flash ? '0 0 0 3px rgba(96,165,250,0.7)' : 'none', transition: 'box-shadow 0.3s',
        }}>
          {m.reply_to && (
            <button onClick={() => onQuote(m.reply_to!.id)} title="Перейти к сообщению"
              style={{ textAlign: 'left', border: 'none', cursor: 'pointer', font: 'inherit', color: 'inherit', padding: '4px 8px', borderRadius: 8,
                borderLeft: `3px solid ${mine ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.4)'}`, background: mine ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.05)' }}>
              <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.75 }}>{m.reply_to.deleted ? '' : m.reply_to.sender === 'admin' ? 'Поддержка' : 'Пользователь'}</div>
              <div style={{ fontSize: 12, opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }}>{quoteText(m.reply_to)}</div>
            </button>
          )}
          {m.files.map((f) => <Attachment key={f.id} f={f} mine={mine} onImage={onImage} onMedia={onMedia} />)}
          {m.text && <div style={{ fontSize: 14, lineHeight: 1.45, wordBreak: 'break-word', padding: m.files.length ? '0 6px 2px' : 0 }}><RichText text={m.text} tone={mine ? 'chatOnLight' : 'chat'} /></div>}
          <div style={{ alignSelf: 'flex-end', fontSize: 11, opacity: 0.55, marginTop: -2, padding: m.files.length && !m.text ? '0 6px 2px' : 0, whiteSpace: 'nowrap' }}>
            {mine && m.author ? `${m.author} · ` : ''}{m.edited ? 'изменено · ' : ''}{hms(m.created_at)}
          </div>
        </div>
        <div className="sup-reply flex flex-col gap-1" style={{ flex: 'none' }}>
          {onReply && <button className="icon-btn" title="Ответить на это сообщение" onClick={() => onReply(m)} style={{ width: 28, height: 28 }}><CornerUpLeft size={14} /></button>}
          {own && onEdit && <button className="icon-btn" title="Изменить (48 часов после отправки)" onClick={() => onEdit(m)} style={{ width: 28, height: 28 }}><Edit2 size={13} /></button>}
          {own && onDelete && <button className="icon-btn" title="Удалить — пропадёт у пользователя" onClick={() => onDelete(m)} style={{ width: 28, height: 28 }}><Trash2 size={13} /></button>}
        </div>
      </div>
    </div>
  );
};

// правая колонка: всё о пользователе
type EditKey = 'SET_TELEGRAM_ID' | 'SET_EMAIL' | 'SET_DEVICES' | 'SET_PARTNER_RATE';

// строка с карандашом (то же действие, что в карточке пользователя)
const EditRow: React.FC<{ k: string; v: React.ReactNode; raw: string; act: EditKey; can: boolean; type?: string;
  onSave: (act: EditKey, value: string) => Promise<boolean> }> = ({ k, v, raw, act, can, type = 'text', onSave }) => {
  const [edit, setEdit] = useState(false);
  const [val, setVal] = useState(raw);
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); const ok = await onSave(act, val.trim()); setBusy(false); if (ok) setEdit(false); };
  return (
    <div className="flex justify-between items-center gap-2" style={{ padding: '4px 0', fontSize: 13, minHeight: 32 }}>
      <span className="sub" style={{ flex: 'none' }}>{k}</span>
      {edit ? (
        <span className="flex items-center gap-1" style={{ minWidth: 0 }}>
          <input className="input mono sm" autoFocus type={type} value={val} onChange={(e) => setVal(e.target.value)} style={{ width: 150, height: 30, padding: '4px 8px' }}
            onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setEdit(false); }} />
          <button className="icon-btn" style={{ width: 28, height: 28 }} title="Сохранить" disabled={busy} onClick={() => void save()}>{busy ? <Spinner size={13} /> : <Save size={13} />}</button>
          <button className="icon-btn" style={{ width: 28, height: 28 }} title="Отмена" onClick={() => setEdit(false)}><X size={13} /></button>
        </span>
      ) : (
        <span className="flex items-center gap-1" style={{ minWidth: 0, textAlign: 'right', wordBreak: 'break-word' }}>
          {v ?? '—'}
          {can && <button className="icon-btn" style={{ width: 26, height: 26 }} title="Изменить" onClick={() => { setVal(raw); setEdit(true); }}><Edit2 size={12} /></button>}
        </span>
      )}
    </div>
  );
};

const UserInfo: React.FC<{ userId: number; onOpenUser: (id: number) => void; reloadKey: string; row: ChatRow;
  canManage: boolean; role: string; onToast: (t: string, m: string, ty: ToastType) => void }> = ({ userId, onOpenUser, reloadKey, row, canManage, role, onToast }) => {
  const [d, setD] = useState<any>(null);
  const [pays, setPays] = useState<any[] | null>(null);
  const [merge, setMerge] = useState<{ act: EditKey; value: string; message: string; text: string } | null>(null);
  const load = useCallback(() => {
    let alive = true;
    apiFetch(`/panel/users/${userId}/detail`).then((x) => alive && setD(x)).catch((e) => alive && setD({ error: parseApiErr(e, '') }));
    apiFetch(`/panel/users/${userId}/payments`).then((x) => alive && setPays(Array.isArray(x) ? x : [])).catch(() => alive && setPays([]));
    return () => { alive = false; };
  }, [userId]);
  useEffect(() => { setD(null); setPays(null); return load(); }, [load, reloadKey]);
  // оператор правит только лимит устройств (tg/почта/реф. ставка: curator/admin)
  const allow = (act: EditKey) => canManage && (role !== 'operator' || act === 'SET_DEVICES');
  const save = async (act: EditKey, value: string, confirm = false): Promise<boolean> => {
    try {
      await apiFetch(`/panel/users/${userId}/action`, { method: 'POST', body: JSON.stringify({ action: act, value, confirm }) });
      onToast('Сохранено', confirm ? 'Аккаунты объединены' : 'Изменено', 'success'); setMerge(null); load(); return true;
    } catch (e) {
      const m = mergeInfo(e);
      if (m) { setMerge({ act, value, message: m.message, text: m.merge?.text || '' }); return false; }
      onToast('Ошибка', parseApiErr(e, 'Не удалось сохранить'), 'error'); return false;
    }
  };
  if (d && d.error) return (
    <div style={{ padding: 16 }}>
      <div style={{ fontWeight: 600 }}>{row.user_label}</div>
      {row.status && <div className="sub" style={{ fontSize: 12, marginTop: 2 }}>{STATUS_RU[row.status] || row.status}</div>}
      <div className="flex items-center gap-2 sub" style={{ fontSize: 12, marginTop: 14 }}><Lock size={13} /> Не удалось загрузить карточку</div>
    </div>
  );
  if (!d) return <div style={{ padding: 30, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  const sub = d.subscription;
  const R = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex justify-between gap-3" style={{ padding: '6px 0', fontSize: 13 }}>
      <span className="sub" style={{ flex: 'none' }}>{k}</span><span style={{ textAlign: 'right', minWidth: 0, wordBreak: 'break-word' }}>{v ?? '—'}</span>
    </div>
  );
  const H = ({ children }: { children: React.ReactNode }) => <div className="faint" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '16px 0 4px' }}>{children}</div>;
  const paid = (pays || []).filter((p) => typeof p.id === 'number');
  return (
    <div style={{ padding: 16 }}>
      <div className="flex items-center gap-3">
        <div style={{ width: 42, height: 42, borderRadius: 12, background: 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600 }}>
          {(d.username || d.email || '#').slice(0, 1).toUpperCase()}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.username ? `@${d.username}` : d.email || `#${d.id}`}</div>
          <div className="sub" style={{ fontSize: 12 }}>{STATUS_RU[d.status] || d.status}</div>
        </div>
      </div>
      {d.is_banned && <div className="badge danger" style={{ marginTop: 12, width: '100%', whiteSpace: 'normal', justifyContent: 'flex-start' }}>Заблокирован{d.ban_reason ? `: ${d.ban_reason}` : ''}</div>}
      {(d.subscriptions_history || []).filter((h: any) => h.status === 'Banned').slice(0, 2).map((h: any) => (
        <div key={h.id} className="badge danger" style={{ marginTop: 8, width: '100%', whiteSpace: 'normal', justifyContent: 'flex-start' }}>Подписка заблокирована{h.ban_reason ? `: ${h.ban_reason}` : ''}</div>
      ))}
      {d.aa_warning && <div className="badge line" style={{ marginTop: 8, width: '100%', whiteSpace: 'normal', justifyContent: 'flex-start', color: '#fb923c', borderColor: 'rgba(251,146,60,.4)' }}>Предупреждение анти-абуза{d.aa_warning.reason ? `: ${d.aa_warning.reason}` : ''} · {fmtDateTime(d.aa_warning.at).slice(0, 16)}</div>}
      <button className="btn sm" style={{ marginTop: 12, width: '100%', justifyContent: 'center' }} onClick={() => onOpenUser(d.id)}><ExternalLink size={14} /> Открыть карточку</button>
      {!canManage && <div className="faint" style={{ fontSize: 11, marginTop: 8 }}>Менять данные можно, когда обращение у вас в работе</div>}

      <H>Профиль</H>
      <R k="ID" v={d.id} />
      <EditRow k="Telegram ID" v={d.telegram_id} raw={String(d.telegram_id ?? '')} act="SET_TELEGRAM_ID" type="number" can={allow('SET_TELEGRAM_ID')} onSave={save} />
      <EditRow k="Email" v={d.email} raw={d.email ?? ''} act="SET_EMAIL" type="email" can={allow('SET_EMAIL')} onSave={save} />
      <R k="Регистрация" v={d.registration_date ? fmtDateTime(d.registration_date).slice(0, 16) : null} />

      <H>Подписка</H>
      {sub ? (<>
        <R k="Действует до" v={sub.expiry_date ? fmtDateTime(sub.expiry_date).slice(0, 16) : null} />
        <R k="Осталось" v={typeof sub.days_left === 'number' ? `${sub.days_left} дн.` : null} />
        <EditRow k="Лимит устройств" v={sub.devices_limit} raw={String(sub.devices_limit ?? 1)} act="SET_DEVICES" type="number" can={allow('SET_DEVICES')} onSave={save} />
        <R k="Тип" v={sub.type === 'trial' ? 'пробная' : 'платная'} />
        {sub.no_renew && <R k="Продление" v={<span style={{ color: 'var(--danger)' }}>запрещено</span>} />}
        {d.key_blocked && <R k="Ключ" v={<span style={{ color: 'var(--danger)' }}>заблокирован</span>} />}
      </>) : <div className="sub" style={{ fontSize: 13 }}>Нет подписки{d.has_trial ? ' · пробный уже брал' : ''}</div>}

      <H>Реферальная программа</H>
      <R k="Реферальный баланс" v={fmtMoney(Number(d.partner_balance || 0))} />
      <EditRow k="Ставка" v={`${d.partner_rate}%`} raw={String(d.partner_rate ?? '')} act="SET_PARTNER_RATE" type="number" can={allow('SET_PARTNER_RATE')} onSave={save} />
      <R k="Приглашено друзей" v={(d.referrals || []).length} />
      {d.discount && <R k="Скидка" v={`${d.discount.percent ?? d.discount.discount_percent ?? ''}%`} />}

      <H>Платежи {paid.length ? `· ${paid.length}` : ''}</H>
      {pays == null ? <Spinner size={16} /> : paid.length === 0 ? <div className="sub" style={{ fontSize: 13 }}>Платежей нет</div> : paid.slice(0, 6).map((p) => (
        <div key={p.id} className="flex justify-between gap-3" style={{ padding: '6px 0', fontSize: 13, borderBottom: '1px solid var(--border)' }}>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block' }}>{p.description || p.purpose}</span>
            <span className="faint" style={{ fontSize: 11 }}>{fmtDateTime(p.paid_at || p.created_at).slice(0, 16)} · {p.provider}{p.status === 'chargeback' ? ' · чарджбек' : p.status === 'refunded' ? ' · возврат' : ''}</span>
          </span>
          <span style={{ flex: 'none', color: p.status !== 'paid' ? 'var(--faint, #888)' : undefined, textDecoration: p.status !== 'paid' ? 'line-through' : undefined }}>
            {p.stars ? `${p.stars} ⭐` : fmtMoney(Number(p.amount || 0))}
          </span>
        </div>
      ))}
      {(d.promo_activations || []).length > 0 && (<>
        <H>Промокоды</H>
        {(d.promo_activations || []).slice(0, 5).map((a: any) => <R key={a.id} k={a.code} v={`${a.discount_percent}%${a.active ? '' : ' · использован'}`} />)}
      </>)}
      {merge && (
        <Modal onClose={() => setMerge(null)} title="Объединить аккаунты?" icon={Info} width={460}
          footer={<><button className="btn" onClick={() => setMerge(null)}>Отмена</button>
            <button className="btn solid" onClick={() => void save(merge.act, merge.value, true)}>Объединить</button></>}>
          <div className="flex flex-col gap-2" style={{ fontSize: 13, lineHeight: 1.5 }}>
            <div>{merge.message}</div>
            {merge.text && <div className="sub" style={{ whiteSpace: 'pre-line' }}>{merge.text}</div>}
          </div>
        </Modal>
      )}
    </div>
  );
};

export const SupportPage: React.FC<{ chatId: number | null; setChatId: (id: number | null) => void; onOpenUser: (id: number) => void; onToast: (t: string, m: string, ty: ToastType) => void }> =
  ({ chatId, setChatId, onOpenUser, onToast }) => {
    // 0 = чат сотрудников (у обращений id >= 1)
    const team = chatId === TEAM_CHAT_ID;
    const sid = team ? null : chatId;
    // высота = видимая область (на телефоне над клавиатурой); скроллятся только список и переписка
    const gridRef = useRef<HTMLDivElement>(null);
    const [vh, setVh] = useState(0);
    const [gridTop, setGridTop] = useState(77);
    const [isPhone, setIsPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches);
    useEffect(() => {
      const vv = window.visualViewport;
      const mq = window.matchMedia('(max-width: 767px)');
      const upd = () => {
        setVh(Math.round(vv ? vv.height : window.innerHeight));
        setIsPhone(mq.matches);
        if (gridRef.current) setGridTop(Math.round(gridRef.current.getBoundingClientRect().top + window.scrollY));
        if (window.scrollY) window.scrollTo(0, 0);
      };
      upd();
      const html = document.documentElement;
      const prev = html.style.overflow;
      html.style.overflow = 'hidden';
      vv?.addEventListener('resize', upd);
      vv?.addEventListener('scroll', upd);
      window.addEventListener('resize', upd);
      return () => {
        html.style.overflow = prev;
        vv?.removeEventListener('resize', upd);
        vv?.removeEventListener('scroll', upd);
        window.removeEventListener('resize', upd);
      };
    }, []);
    const [teamUnread, setTeamUnread] = useState(0);
    const [chats, setChats] = useState<ChatRow[] | null>(null);
    const [status, setStatus] = useState<Tab>('open');
    const [counts, setCounts] = useState<Partial<Record<Tab, number>> | null>(null);
    const [tabs, setTabs] = useState<Tab[]>(['open', 'mine']);
    const [reply, setReply] = useState<SMsg | null>(null);
    const [editing, setEditing] = useState<SMsg | null>(null);
    const [flashId, setFlashId] = useState<number | null>(null);
    const [q, setQ] = useState('');
    const [data, setData] = useState<ChatData | null>(null);
    const [text, setText] = useState('');
    const [noteMode, setNoteMode] = useState(false);
    const [pending, setPending] = useState<Pending[]>([]);
    const [busy, setBusy] = useState('');
    const [viewer, setViewer] = useState<string | null>(null);
    const [infoOpen, setInfoOpen] = useState(false);
    const [poolOpen, setPoolOpen] = useState(false);
    const [poolNote, setPoolNote] = useState('');
    const listRef = useRef<HTMLDivElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const lastId = useRef(0);
    const stick = useRef(true);

    const loadChats = useCallback(() => {
      apiFetch(`/panel/support/chats?q=${encodeURIComponent(q)}&status=${status}`)
        .then((x) => { setChats(Array.isArray(x?.chats) ? x.chats : []); setCounts(x?.counts || null); if (Array.isArray(x?.tabs)) setTabs(x.tabs); })
        .catch(() => setChats([]));
    }, [q, status]);
    useEffect(() => { loadChats(); const t = setInterval(loadChats, 8000); return () => clearInterval(t); }, [loadChats]);
    useEffect(() => {
      const load = () => apiFetch('/panel/team-chat/unread').then((r) => setTeamUnread(Number(r?.unread || 0))).catch(() => {});
      load(); const t = setInterval(load, 8000);
      window.addEventListener('support-unread', load);
      return () => { clearInterval(t); window.removeEventListener('support-unread', load); };
    }, []);

    // открытый чат: загрузка, read, опрос
    useEffect(() => {
      setData(null); setText(''); setPending([]); setReply(null); setEditing(null); setNoteMode(false); lastId.current = 0; stick.current = true;
      if (sid == null) return;
      let alive = true;
      const first = () => apiFetch(`/panel/support/chats/${sid}`).then((d: ChatData) => {
        if (!alive) return;
        lastId.current = d.messages.length ? d.messages[d.messages.length - 1].id : 0;
        setData(d);
        if (d.chat.unread) apiFetch(`/panel/support/chats/${sid}/read`, { method: 'POST' }).then(() => { loadChats(); pingUnread(); }).catch(() => {});
      });
      first().catch((e) => onToast('Ошибка', parseApiErr(e, 'Чат не найден'), 'error'));
      const t = setInterval(() => {
        apiFetch(`/panel/support/chats/${sid}?after=${lastId.current}`).then((d: ChatData) => {
          if (!alive) return;
          const cur0 = dataRef.current;
          const t0 = cur0?.chat.ticket, t1 = d.chat.ticket;
          if (cur0 && (t0?.status !== t1?.status || t0?.number !== t1?.number || !!t0?.close_prompt !== !!t1?.close_prompt)) {
            // статус/вопрос о закрытии изменился → полная перечитка
            reloadChat();
            return;
          }
          setData((cur) => {
            if (!cur) return d;
            const have = new Set(cur.messages.map((m) => m.id));
            const add = d.messages.filter((m) => !have.has(m.id));
            if (d.messages.length) lastId.current = Math.max(lastId.current, ...d.messages.map((m) => m.id));
            // правки/удаления (в т.ч. из другой вкладки)
            const ch = new Map((d.changes || []).map((m) => [m.id, m]));
            let msgs = ch.size ? cur.messages.map((m) => ch.get(m.id) || m) : cur.messages;
            if (add.length) msgs = [...msgs, ...add].sort((a, b) => a.id - b.id);
            return { ...d, messages: msgs };
          });
          if (d.messages.some((m) => m.sender === 'user')) apiFetch(`/panel/support/chats/${sid}/read`, { method: 'POST' }).catch(() => {});
        }).catch((e) => {
          // забрали/передали: этому сотруднику чат больше не виден
          if (alive && /Чат не найден/.test(String(e?.message))) {
            onToast('Обращение', 'Обращение больше недоступно — его взял другой сотрудник или оно передано', 'info' as ToastType);
            setChatId(null); loadChats(); pingUnread();
          }
        });
      }, POLL_MS);
      return () => { alive = false; clearInterval(t); };
    }, [sid]);

    const dataRef = useRef<ChatData | null>(null);
    dataRef.current = data;
    const reloadChat = useCallback(() => {
      if (sid == null) return Promise.resolve();
      return apiFetch(`/panel/support/chats/${sid}`).then((d: ChatData) => {
        lastId.current = d.messages.length ? d.messages[d.messages.length - 1].id : 0;
        setData(d);
      }).catch(() => {});
    }, [sid]);

    const keepBottom = useCallback(() => { const el = listRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, []);
    useLayoutEffect(() => { keepBottom(); }, [data?.messages.length, keepBottom]);

    const start = async (takeover = false) => {
      if (sid == null) return;
      setBusy('start');
      try {
        await apiFetch(`/panel/support/chats/${sid}/start`, { method: 'POST', body: JSON.stringify({ takeover }) });
        const d: ChatData = await apiFetch(`/panel/support/chats/${sid}`);
        lastId.current = d.messages.length ? d.messages[d.messages.length - 1].id : 0;
        stick.current = true; setData(d); loadChats();
      } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось начать'), 'error'); } finally { setBusy(''); }
    };

    const reopen = async () => {
      if (sid == null) return;
      setBusy('reopen');
      try {
        await apiFetch(`/panel/support/chats/${sid}/reopen`, { method: 'POST' });
        const d: ChatData = await apiFetch(`/panel/support/chats/${sid}`);
        lastId.current = d.messages.length ? d.messages[d.messages.length - 1].id : 0;
        stick.current = true; setData(d); loadChats();
      } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось переоткрыть'), 'error'); } finally { setBusy(''); }
    };

    const act = async (what: 'close' | 'force' | 'pool' | 'escalate', poolReason?: string) => {
      if (sid == null || !data?.chat.ticket) return;
      const num = data.chat.ticket.number;
      if (what === 'force' && !window.confirm(`Закрыть обращение №${num} сразу, без вопроса пользователю?`)) return;
      if (what === 'escalate' && !window.confirm(`Передать обращение №${num} админу?`)) return;
      if (what === 'pool' && !data.me.full) {
        const note = (poolReason ?? poolNote).trim();
        if (note.length < 3) { onToast('Ошибка', 'Укажите причину возврата в пул', 'error'); return; }
      }
      setBusy(what);
      try {
        let r: any = null;
        if (what === 'close' || what === 'force') r = await apiFetch(`/panel/support/chats/${sid}/close`, { method: 'POST', body: JSON.stringify({ force: what === 'force' }) });
        if (what === 'pool') {
          const note = data.me.full ? '' : (poolReason ?? poolNote).trim();
          await apiFetch(`/panel/support/chats/${sid}/pool`, { method: 'POST', body: JSON.stringify({ note }) });
          setPoolOpen(false); setPoolNote('');
        }
        if (what === 'escalate') await apiFetch(`/panel/support/chats/${sid}/escalate`, { method: 'POST', body: JSON.stringify({}) });
        setReply(null); loadChats(); pingUnread();
        if (what === 'pool' || what === 'escalate') {
          onToast('Готово', what === 'pool' ? `Обращение №${num} возвращено в пул` : `Обращение №${num} передано админу`, 'success');
          if (!data.me.full) { setChatId(null); return; }
        }
        stick.current = true; await reloadChat();
        if (r?.state === 'closed') onToast('Готово', `Обращение №${num} закрыто`, 'success');
        else if (r?.state === 'asked') onToast('Вопрос отправлен', `Ответ «нет» или «спасибо» закроет обращение. Нет ответа ${data.me.prompt_ttl_min} мин — закроется само`, 'success');
      } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось'), 'error'); } finally { setBusy(''); }
    };
    const jumpTo = (id: number) => {
      const el = listRef.current?.querySelector(`[data-mid="${id}"]`) as HTMLElement | null;
      if (!el) { onToast('Сообщение', 'Исходное сообщение уже удалено', 'info' as ToastType); return; }
      stick.current = false;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashId(id); setTimeout(() => setFlashId(null), 1400);
    };

    const limits = data?.limits || { max_file_mb: 50, max_files: 10, max_text: 4000 };
    const addFiles = (list: FileList | null) => {
      if (!list || sid == null) return;
      const room = limits.max_files - pending.length;
      Array.from(list).slice(0, Math.max(0, room)).forEach((file) => {
        const key = `${Date.now()}-${Math.random()}`;
        if (file.size > limits.max_file_mb * 1048576) { setPending((p) => [...p, { key, file, progress: 0, error: `больше ${limits.max_file_mb} МБ` }]); return; }
        const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
        const up = uploadFile(sid, file, (pr) => setPending((p) => p.map((x) => (x.key === key ? { ...x, progress: pr } : x))));
        setPending((p) => [...p, { key, file, preview, progress: 0, abort: up.abort }]);
        up.promise.then((r) => setPending((p) => p.map((x) => (x.key === key ? { ...x, id: r.id, progress: 1 } : x))))
          .catch((e: Error) => setPending((p) => p.map((x) => (x.key === key ? { ...x, error: e.message } : x))));
      });
      if (fileRef.current) fileRef.current.value = '';
    };
    const removePending = (key: string) => setPending((p) => {
      const x = p.find((y) => y.key === key);
      if (x?.abort && !x.id && !x.error) x.abort();
      if (x?.preview) URL.revokeObjectURL(x.preview);
      return p.filter((y) => y.key !== key);
    });
    const uploading = pending.some((p) => !p.id && !p.error);
    const ready = pending.filter((p) => p.id);
    const canSend = !busy && !uploading && (text.trim().length > 0 || ready.length > 0);
    const replaceMsg = (m: SMsg) => setData((cur) => (cur ? { ...cur, messages: cur.messages.map((x) => (x.id === m.id ? m : x)) } : cur));
    const startEdit = (m: SMsg) => { setReply(null); setEditing(m); setNoteMode(!!m.internal); setText(m.text || ''); };
    const cancelEdit = () => { setEditing(null); setText(''); };
    const removeMsg = async (m: SMsg) => {
      const ask = m.internal
        ? 'Удалить комментарий? Его увидят только сотрудники — у пользователя его и так нет.'
        : 'Удалить сообщение? У пользователя оно пропадёт (и уведомление в Telegram тоже).';
      if (sid == null || !window.confirm(ask)) return;
      try {
        await apiFetch(`/panel/support/chats/${sid}/messages/${m.id}`, { method: 'DELETE' });
        replaceMsg({ ...m, deleted: true, text: '', files: [] });
        if (editing?.id === m.id) cancelEdit();
        loadChats();
      } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось удалить'), 'error'); }
    };
    const send = async () => {
      if (sid == null) return;
      if (editing) {
        if (busy || !text.trim() && !editing.files.length) return;
        setBusy('send');
        try {
          const m: SMsg = await apiFetch(`/panel/support/chats/${sid}/messages/${editing.id}/edit`, { method: 'POST', body: JSON.stringify({ text: text.trim() }) });
          replaceMsg(m); cancelEdit(); loadChats();
        } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось изменить'), 'error'); } finally { setBusy(''); }
        return;
      }
      const asNote = noteMode || editing?.internal;
      if (asNote) {
        if (busy || !text.trim()) return;
        setBusy('send');
        try {
          const m: SMsg = await apiFetch(`/panel/support/chats/${sid}/messages`, {
            method: 'POST',
            body: JSON.stringify({ text: text.trim(), internal: true, reply_to: reply?.id || null }),
          });
          stick.current = true;
          setData((cur) => (cur ? { ...cur, messages: [...cur.messages.filter((x) => x.id !== m.id), m].sort((a, b) => a.id - b.id) } : cur));
          setText(''); setReply(null);
        } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось отправить комментарий'), 'error'); } finally { setBusy(''); }
        return;
      }
      if (!canSend) return;
      setBusy('send');
      try {
        const m: SMsg = await apiFetch(`/panel/support/chats/${sid}/messages`, { method: 'POST', body: JSON.stringify({ text: text.trim(), files: ready.map((p) => p.id), reply_to: reply?.id || null }) });
        stick.current = true;
        // lastId не двигаем: сообщение юзера перед нашим подтянет опрос
        setData((cur) => (cur ? { ...cur, messages: [...cur.messages.filter((x) => x.id !== m.id), m].sort((a, b) => a.id - b.id) } : cur));
        setText(''); setReply(null); pending.forEach((p) => p.preview && URL.revokeObjectURL(p.preview)); setPending((p) => p.filter((x) => x.error));
        loadChats();
      } catch (e) { onToast('Ошибка', parseApiErr(e, 'Не удалось отправить'), 'error'); } finally { setBusy(''); }
    };

    const chat = data?.chat;
    const height = vh ? `${Math.max(320, vh - gridTop - 20)}px` : 'calc(100dvh - 57px - 40px)';

    const list = (
      <div className="card" style={{ padding: 0, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        <div style={{ padding: 12, borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="flex gap-1" style={{ flexWrap: 'wrap' }}>
            {tabs.map((t) => (
              <button key={t} className={`btn sm ${status === t ? 'solid' : ''}`} onClick={() => setStatus(t)} style={{ padding: '5px 10px' }}>
                {TAB_RU[t]}{counts && counts[t] && t !== 'archive' ? <span style={{ opacity: 0.6, marginLeft: 4 }}>{counts[t]}</span> : null}
              </button>
            ))}
          </div>
          <div className="search">
            <Search className="ico" size={16} />
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Имя, @username, ID, email…" />
          </div>
        </div>
        <button onClick={() => setChatId(TEAM_CHAT_ID)}
          style={{ display: 'flex', gap: 10, alignItems: 'center', width: '100%', textAlign: 'left', padding: '11px 14px', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer', color: 'inherit', font: 'inherit',
            background: team ? 'rgba(255,255,255,0.07)' : 'rgba(255,107,26,0.06)' }}>
          <div style={{ flex: 'none', width: 38, height: 38, borderRadius: 11, background: 'rgba(255,107,26,0.18)', color: '#ff8a3d', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Users size={18} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: teamUnread ? 600 : 500 }}>Чат сотрудников</div>
            <div className="sub" style={{ fontSize: 12 }}>Общий чат команды поддержки</div>
          </div>
          {teamUnread > 0 && <span style={{ flex: 'none', minWidth: 20, height: 20, padding: '0 6px', borderRadius: 10, background: '#ff6b1a', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{teamUnread}</span>}
        </button>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {chats == null ? <div style={{ padding: 30, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            : chats.length === 0 ? <div className="sub" style={{ padding: 20, textAlign: 'center', fontSize: 13 }}>{q ? 'Ничего не найдено' : TAB_EMPTY[status]}</div>
            : chats.map((c, i) => {
              const esc = !!(c.ticket?.escalated && !c.ticket.assigned_name);
              const section =
                status === 'work' && c.group === 'escalated' && (i === 0 || chats[i - 1].group !== 'escalated')
                  ? 'Передано админу'
                  : status === 'work' && c.group === 'others' && (i === 0 || chats[i - 1].group !== 'others')
                    ? 'Ведут другие сотрудники'
                    : status === 'work' && c.group === 'mine' && (i === 0 || chats[i - 1].group !== 'mine')
                      && chats.some((x) => x.group === 'escalated')
                      ? 'Мои обращения'
                      : null;
              return (
              <React.Fragment key={c.id}>
              {section && (
                <div className="faint flex items-center gap-2" style={{
                  fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '10px 14px 6px',
                  borderBottom: '1px solid var(--border)',
                  color: section === 'Передано админу' ? '#ff8a3d' : undefined,
                }}>
                  {section === 'Передано админу' ? <ShieldAlert size={12} /> : null}{section}
                </div>
              )}
              <button onClick={() => setChatId(c.id)}
                style={{ display: 'flex', gap: 10, width: '100%', textAlign: 'left', padding: '12px 14px', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer', color: 'inherit', font: 'inherit',
                  background: sid === c.id ? 'rgba(255,255,255,0.07)' : esc ? 'rgba(255,107,26,0.07)' : 'transparent',
                  boxShadow: esc ? 'inset 3px 0 0 #ff6b1a' : undefined }}>
                <div style={{ flex: 'none', width: 38, height: 38, borderRadius: 11,
                  background: esc ? 'rgba(255,107,26,0.18)' : 'rgba(255,255,255,0.08)',
                  color: esc ? '#ff8a3d' : undefined,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 14 }}>
                  {esc ? <ShieldAlert size={18} /> : (c.user_label || '#').replace('@', '').slice(0, 1).toUpperCase()}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="flex justify-between gap-2">
                    <span style={{ fontWeight: (c.unread || esc) ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.user_label}</span>
                    <span className="faint" style={{ fontSize: 11, flex: 'none' }}>
                      {c.ticket ? <span style={{ marginRight: 6 }}>№{c.ticket.number}{c.ticket.status === 'closed' ? ' · закрыт' : c.ticket.close_prompt ? ' · закрывается' : c.ticket.assigned_to_me ? '' : c.ticket.assigned_name ? ` · ведёт ${c.ticket.assigned_name}` : ''}</span> : null}
                      {shortWhen(c.last_message_at)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2" style={{ marginTop: 2 }}>
                    <span className={c.unread || esc ? '' : 'sub'} style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {esc
                        ? <><span style={{ color: '#ff8a3d', fontWeight: 600 }}>Передано вам</span>{c.ticket?.escalate_note ? ` · ${c.ticket.escalate_note}` : c.last_preview ? ` · ${c.last_preview}` : ''}</>
                        : <>{c.last_sender === 'admin' ? 'Поддержка: ' : ''}{c.last_preview}</>}
                    </span>
                    {(c.unread > 0 || esc) && (
                      <span style={{
                        flex: 'none', minWidth: 20, height: 20, padding: '0 6px', borderRadius: 10,
                        background: esc ? '#ff6b1a' : '#fff', color: esc ? '#fff' : '#000',
                        fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>{c.unread > 0 ? c.unread : '!'}</span>
                    )}
                  </div>
                </div>
              </button>
              </React.Fragment>
              );
            })}
        </div>
      </div>
    );

    const dialog = team ? <TeamChat onBack={() => setChatId(null)} onToast={onToast} /> : sid == null ? (
      <div className="card flex flex-col items-center justify-center sub" style={{ gap: 10, minHeight: 0 }}>
        <MessageCircle size={34} className="faint" />
        <div>Выберите обращение слева</div>
      </div>
    ) : (
      <div className="card" style={{ padding: 0, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        <div className="flex items-center justify-between gap-3" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
            <button className="icon-btn lg:!hidden" onClick={() => setChatId(null)} title="К списку"><ArrowLeft size={16} /></button>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chat?.user_label || '…'}</div>
              <div className="sub" style={{ fontSize: 12 }}>
                {chat?.ticket ? (chat.ticket.status === 'open'
                  ? (chat.ticket.assigned_name ? `Ведёт ${chat.ticket.assigned_name}` : chat.ticket.escalated ? 'Ожидает администратора' : 'Ожидает оператора')
                  : 'Закрыто') : ''}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2" style={{ flex: 'none' }}>
            {chat && (!chat.ticket || chat.ticket.status !== 'open') && isPhone && (
              <DotsMenu items={[{ label: 'О пользователе', icon: Info, onClick: () => setInfoOpen(true) }]} />
            )}
            {chat?.ticket?.status === 'open' && data && (() => {
              const t = chat.ticket;
              const mine = chat.started_by_me;
              const full = data.me.full;
              const deadline = t.prompt_at ? new Date(new Date(t.prompt_at).getTime() + data.me.prompt_ttl_min * 60000) : null;
              const takenByOther = !!t.assigned_name && !mine;
              const canTake = !!t.can_takeover;
              // своё; эскалация без ведущего; чужое — только если можно перебить (куратор → оператор)
              const canPool = mine || (full && (canTake || (!t.assigned_name && !!t.escalated)));
              return (<>
                {t.close_prompt && <span className="badge" title="Пользователь может ответить «нет»/«спасибо» или нажать кнопку">Ждём ответа{deadline ? ` до ${hm(deadline.toISOString())}` : ''}</span>}
                {busy && busy !== 'send' && busy !== 'start' && <Spinner size={16} />}
                <DotsMenu items={[
                  full && takenByOther && canTake && { label: `Забрать себе (ведёт ${t.assigned_name})`, icon: Play, onClick: () => void start(true) },
                  canPool && {
                    label: 'В пул', icon: Undo2,
                    onClick: () => { if (full) void act('pool'); else { setPoolNote(''); setPoolOpen(true); } },
                  },
                  mine && !full && { label: 'Передать админу', icon: ShieldAlert, onClick: () => void act('escalate') },
                  (mine || full) && { label: 'Закрыть (спросить пользователя)', icon: CheckCircle, onClick: () => void act('close'),
                    disabled: !!t.close_prompt, hint: 'Вопрос уже задан — ждём ответа' },
                  full && { label: 'Закрыть сразу', icon: XCircle, danger: true, onClick: () => void act('force') },
                  isPhone && { label: 'О пользователе', icon: Info, onClick: () => setInfoOpen(true) },
                ]} />
              </>);
            })()}
            {chat && !isPhone && <button className="btn sm 2xl:!hidden" onClick={() => setInfoOpen(true)}><Info size={14} /> О пользователе</button>}
          </div>
        </div>

        <div ref={listRef} onScroll={() => { const el = listRef.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
          style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {!data ? <div style={{ margin: 'auto' }}><Spinner /></div> : data.messages.map((m, i) => {
            const day = i === 0 || new Date(data.messages[i - 1].created_at).toDateString() !== new Date(m.created_at).toDateString();
            return (
              <React.Fragment key={m.id}>
                {day && <div className="faint" style={{ alignSelf: 'center', fontSize: 11, margin: '6px 0' }}>{fmtDateTime(m.created_at).slice(0, 10)}</div>}
                <Bubble m={m} onImage={setViewer} onMedia={keepBottom} onQuote={jumpTo} flash={flashId === m.id}
                  onReply={m.sender !== 'system' ? (x) => { setEditing(null); setReply(x); if (x.internal) setNoteMode(true); } : undefined}
                  onEdit={startEdit} onDelete={(x) => void removeMsg(x)} />
              </React.Fragment>
            );
          })}
        </div>

        <div style={{ borderTop: '1px solid var(--border)', padding: 12 }}>
          {!chat || !data ? null : (() => {
            // писать пользователю — только после «Начать» (и у админа тоже)
            const canWriteUser = !!chat.started_by_me;
            const taken = chat.ticket?.status === 'open' && !!chat.ticket.assigned_name && !chat.ticket.assigned_to_me;
            const canStart = !chat.started_by_me && chat.ticket?.status === 'open' && (!taken || !!chat.ticket?.can_takeover);
            const canReopen = !!data.me.full && chat.ticket?.status === 'closed';
            const asNote = !!editing?.internal || noteMode;
            const canNoteSend = !busy && text.trim().length > 0;
            const pickMode = (note: boolean) => {
              if (editing) return;
              setNoteMode(note);
              if (note && pending.length) setPending((p) => { p.forEach((x) => x.preview && URL.revokeObjectURL(x.preview)); return []; });
            };
            // вкладка «Сообщение» без взятого тикета: «Начать» / «Забрать» вместо поля
            const messageAction = !canWriteUser && !asNote && !editing ? (
              canStart ? (
                <button className="btn solid" style={{ width: '100%', justifyContent: 'center', minHeight: 42 }}
                  disabled={busy === 'start'} onClick={() => void start(taken)}>
                  {busy === 'start' ? <Spinner size={15} /> : <Play size={15} />} {taken ? 'Забрать обращение' : 'Начать'}
                </button>
              ) : canReopen ? (
                <button className="btn solid" style={{ width: '100%', justifyContent: 'center', minHeight: 42 }}
                  disabled={busy === 'reopen'} onClick={() => void reopen()}>
                  {busy === 'reopen' ? <Spinner size={15} /> : <Play size={15} />} Переоткрыть
                </button>
              ) : (
                <div className="sub" style={{ fontSize: 13, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, textAlign: 'center' }}>
                  {taken ? `Ведёт ${chat.ticket!.assigned_name}` : chat.ticket?.status !== 'open' ? 'Обращение закрыто' : 'Нет открытого обращения'}
                </div>
              )
            ) : null;
            return (
              <div className="flex flex-col gap-2">
                {pending.length > 0 && !asNote && canWriteUser && (
                  <div className="flex gap-2" style={{ overflowX: 'auto', paddingBottom: 4 }}>
                    {pending.map((p) => (
                      <div key={p.key} style={{ position: 'relative', flex: 'none', width: 68, height: 68, borderRadius: 10, border: `1px solid ${p.error ? 'var(--danger)' : 'var(--border)'}`, overflow: 'hidden', background: 'rgba(255,255,255,0.04)' }}>
                        {p.preview ? <img src={p.preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: p.id ? 1 : 0.5 }} />
                          : <div className="sub" style={{ padding: 6, fontSize: 10, wordBreak: 'break-all', lineHeight: 1.3 }}><FileText size={16} /><div style={{ maxHeight: 26, overflow: 'hidden' }}>{p.file.name}</div></div>}
                        {!p.id && !p.error && <div style={{ position: 'absolute', left: 5, right: 5, bottom: 5, height: 3, background: 'rgba(0,0,0,0.5)', borderRadius: 2 }}><div style={{ width: `${Math.round(p.progress * 100)}%`, height: '100%', background: '#fff', borderRadius: 2 }} /></div>}
                        {p.error && <div style={{ position: 'absolute', inset: 'auto 0 0 0', fontSize: 9, background: 'rgba(0,0,0,0.75)', color: 'var(--danger)', padding: '2px 3px' }}>{p.error}</div>}
                        <button onClick={() => removePending(p.key)} title="Убрать" style={{ position: 'absolute', top: 3, right: 3, width: 20, height: 20, borderRadius: 10, border: 'none', background: 'rgba(0,0,0,0.65)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}><X size={12} /></button>
                      </div>
                    ))}
                  </div>
                )}
                {editing && (
                  <div className="flex items-center gap-3" style={{ padding: '6px 10px', borderLeft: '3px solid var(--border-strong)', background: 'rgba(255,255,255,0.04)', borderRadius: 8 }}>
                    <Edit2 size={15} className="faint" style={{ flex: 'none' }} />
                    <div style={{ minWidth: 0, flex: 1, cursor: 'pointer' }} onClick={() => jumpTo(editing.id)}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>Редактирование</div>
                      <div className="sub" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{editing.text || (editing.files.length ? `📎 ${editing.files[0].name}` : '')}</div>
                    </div>
                    <button className="icon-btn" style={{ width: 26, height: 26 }} title="Отменить (Esc)" onClick={cancelEdit}><X size={13} /></button>
                  </div>
                )}
                {reply && (
                  <div className="flex items-center gap-3" style={{ padding: '6px 10px', borderLeft: '3px solid var(--border-strong)', background: 'rgba(255,255,255,0.04)', borderRadius: 8 }}>
                    <CornerUpLeft size={15} className="faint" style={{ flex: 'none' }} />
                    <div style={{ minWidth: 0, flex: 1, cursor: 'pointer' }} onClick={() => jumpTo(reply.id)}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>Ответ</div>
                      <div className="sub" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{reply.text || (reply.files.length ? `📎 ${reply.files[0].name}` : '')}</div>
                    </div>
                    <button className="icon-btn" style={{ width: 26, height: 26 }} title="Отменить" onClick={() => setReply(null)}><X size={13} /></button>
                  </div>
                )}
                <div className="flex items-end gap-2">
                  {canWriteUser && !asNote && (
                    <>
                      <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => addFiles(e.target.files)} />
                      <button className="icon-btn" style={{ width: 42, height: 42, flex: 'none' }} title="Прикрепить" onClick={() => fileRef.current?.click()}><Paperclip size={17} /></button>
                    </>
                  )}
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {!editing && (
                      <div style={{ display: 'inline-flex', alignSelf: 'flex-start', padding: 2, borderRadius: 8, background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border)' }}>
                        <button type="button" onClick={() => pickMode(false)}
                          style={{
                            border: 'none', cursor: 'pointer', font: 'inherit',
                            padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                            background: !asNote ? 'rgba(255,255,255,0.12)' : 'transparent',
                            color: !asNote ? 'var(--text)' : 'var(--muted, #9a9a9a)',
                          }}>Сообщение</button>
                        <button type="button" onClick={() => pickMode(true)}
                          style={{
                            border: 'none', cursor: 'pointer', font: 'inherit',
                            padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                            background: asNote ? 'rgba(255,255,255,0.12)' : 'transparent',
                            color: asNote ? 'var(--text)' : 'var(--muted, #9a9a9a)',
                          }}>Комментарий</button>
                      </div>
                    )}
                    {messageAction || (
                      <textarea className="input" rows={1} value={text}
                        placeholder={asNote ? 'Комментарий для сотрудников…' : 'Сообщение пользователю…'}
                        onChange={(e) => { setText(e.target.value.slice(0, limits.max_text)); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`; }}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } if (e.key === 'Escape' && editing) cancelEdit(); }}
                        style={{ width: '100%', resize: 'none', minHeight: 42, maxHeight: 160, lineHeight: 1.4, paddingTop: 10, paddingBottom: 10 }} />
                    )}
                  </div>
                  {(asNote || canWriteUser || editing) && (
                    <button className="btn solid" style={{ height: 42, flex: 'none' }}
                      title={editing ? 'Сохранить' : 'Отправить'}
                      disabled={editing ? !!busy || (!text.trim() && !editing.files.length) : asNote ? !canNoteSend : !canSend}
                      onClick={() => void send()}>
                      {busy === 'send' || uploading ? <Spinner size={15} /> : editing ? <Save size={15} /> : <Send size={15} />}
                    </button>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    );

    return (
      <div ref={gridRef} className="support-grid" style={{ height }}>
        <style>{`
          .support-grid { display: grid; gap: 16px; grid-template-columns: 1fr; }
          .support-grid > .sg-list { display: ${chatId == null ? 'flex' : 'none'}; }
          .support-grid > .sg-dialog { display: ${chatId == null ? 'none' : 'flex'}; }
          .support-grid > .sg-info { display: none; }
          @media (min-width: 1024px) {
            .support-grid { grid-template-columns: 320px minmax(0, 1fr); }
            .support-grid > .sg-list, .support-grid > .sg-dialog { display: flex; }
          }
          @media (min-width: 1536px) {
            .support-grid { grid-template-columns: 320px minmax(0, 1fr) 340px; }
            .support-grid > .sg-info { display: flex; }
          }
          .support-grid > div { min-height: 0; flex-direction: column; }
          .support-grid > div > .card { flex: 1; }
          .sup-msg .sup-reply { opacity: 0; transition: opacity .15s; }
          .sup-msg:hover .sup-reply { opacity: 1; }
          @media (hover: none) { .sup-msg .sup-reply { opacity: .6; } }
        `}</style>
        <div className="sg-list">{list}</div>
        <div className="sg-dialog">{dialog}</div>
        <div className="sg-info">
          <div className="card" style={{ padding: 0, overflowY: 'auto', minHeight: 0 }}>
            {team ? (
              <div style={{ padding: 20, fontSize: 13 }} className="sub flex flex-col gap-2">
                <div style={{ fontWeight: 600, color: 'var(--text)' }}>Чат сотрудников</div>
                <div>Сообщения видят администратор, кураторы и операторы. Пользователям чат не виден.</div>
                <div>Удалить можно своё сообщение; администратор может удалить любое.</div>
                <div>О новых сообщениях приходят push-уведомления (если включены колокольчиком вверху).</div>
              </div>
            ) : chat && data ? <UserInfo userId={chat.user_id} onOpenUser={onOpenUser} reloadKey={String(chat.started_by_me)} row={chat} canManage={data.me.can_manage_user} role={data.me.role} onToast={onToast} /> : <div className="sub" style={{ padding: 20, fontSize: 13 }}>Здесь будет информация о пользователе</div>}
          </div>
        </div>
        {infoOpen && chat && (
          <Modal onClose={() => setInfoOpen(false)} title="О пользователе" icon={Info} width={420}>
            <div style={{ margin: -16 }}>{data && <UserInfo userId={chat.user_id} onOpenUser={(id) => { setInfoOpen(false); onOpenUser(id); }} reloadKey={String(chat.started_by_me)} row={chat} canManage={data.me.can_manage_user} role={data.me.role} onToast={onToast} />}</div>
          </Modal>
        )}
        {poolOpen && (
          <Modal onClose={() => { setPoolOpen(false); setPoolNote(''); }} title="Вернуть в пул" icon={Undo2} width={440}
            footer={<><button className="btn" onClick={() => { setPoolOpen(false); setPoolNote(''); }}>Отмена</button>
              <button className="btn solid" disabled={!!busy || poolNote.trim().length < 3} onClick={() => void act('pool', poolNote)}>
                {busy === 'pool' ? <Spinner size={15} /> : <Undo2 size={15} />} В пул
              </button></>}>
            <div className="flex flex-col gap-3">
              <div className="sub" style={{ fontSize: 13 }}>Обращение снова смогут взять другие операторы. Укажите, почему не продолжаете.</div>
              <div>
                <label className="field-label">Причина</label>
                <textarea className="input" rows={3} maxLength={500} value={poolNote} onChange={(e) => setPoolNote(e.target.value)}
                  placeholder="Например: нужна помощь админа по возврату / не успеваю сегодня" style={{ resize: 'vertical' }} />
              </div>
            </div>
          </Modal>
        )}
        {viewer && (
          <div onClick={() => setViewer(null)} style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, cursor: 'zoom-out' }}>
            <img src={viewer} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          </div>
        )}
      </div>
    );
  };
