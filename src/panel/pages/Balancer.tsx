import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Check, ChevronRight, Eye, Plus, RefreshCw, Search, ShieldCheck, Trash2, Zap } from 'lucide-react';
import { Modal, PageHead, Spinner, Toggle } from '../components/ui';
import { apiFetch, parseApiErr } from '../lib/api';
import type { ToastType } from '../lib/types';

type RwHost = { uuid: string; remark: string; address: string; port: number | null; disabled: boolean; hidden: boolean; description: string; group: string | null };
type Group = { id: string; name: string; hosts: string[]; whitelist: boolean; description: string; template_uuid: string | null };
type Settings = { auto_group_name: string; auto_template_uuid: string | null; groups: Group[] };
type Tpl = { uuid: string; name: string };
type State = {
  xbm: { running: boolean }; configured: boolean; settings: Settings; hosts: RwHost[];
  templates: Tpl[] | null; templates_error: string | null; duplicates: string[];
  last_sync: { at: number | null; ok: boolean | null; error: string | null; warnings: string[] }; error: string | null;
  limits: { name: number; description: number; groups: number };
};
type Loc = { name: string; description: string; servers: string[]; reserve: string[] };
type Toast = (t: string, m: string, ty: ToastType) => void;

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(16).padStart(2, '0')).join('');
const plural = (n: number, a: string, b: string, c: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c;
};
const hostsWord = (n: number) => `${n} ${plural(n, 'сервер', 'сервера', 'серверов')}`;

/** Панель → «Балансировщик»: список строк подписки. Нажали на строку — настроили. */
export const BalancerPage: React.FC<{ onToast: Toast }> = ({ onToast }) => {
  const [st, setSt] = useState<State | null>(null);
  const [edit, setEdit] = useState<Group | 'auto' | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => apiFetch('/panel/xbm').then(setSt).catch((e) => onToast('Ошибка', parseApiErr(e, 'Не удалось загрузить'), 'error')), [onToast]);
  useEffect(() => { load(); }, [load]);
  const byUuid = useMemo(() => Object.fromEntries((st?.hosts || []).map((h) => [h.uuid, h])), [st]);

  if (!st) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  const s = st.settings;

  /** Сохраняет сразу — отдельной кнопки «Сохранить» на странице нет. */
  const save = async (next: Settings, msg = 'Сохранено'): Promise<boolean> => {
    setBusy(true);
    try {
      setSt(await apiFetch('/panel/xbm', { method: 'PUT', body: JSON.stringify(next) }));
      onToast(msg, 'У пользователей обновится при следующем обновлении подписки', 'success');
      return true;
    } catch (e) { onToast('Не сохранено', parseApiErr(e, 'Ошибка'), 'error'); return false; } finally { setBusy(false); }
  };
  const move = (id: string, d: -1 | 1) => {
    const g = [...s.groups];
    const i = g.findIndex((x) => x.id === id), j = i + d;
    if (i < 0 || j < 0 || j >= g.length) return;
    [g[i], g[j]] = [g[j], g[i]];
    void save({ ...s, groups: g }, 'Порядок изменён');
  };

  const active = st.hosts.filter((h) => !h.disabled);
  const inGroups = new Set(s.groups.flatMap((g) => g.hosts));
  const problem = !st.xbm.running ? 'XBM не запущен — установите его в Настройки → XBM'
    : st.error || (st.last_sync.ok === false ? `Не удалось связаться с Remnawave: ${st.last_sync.error}` : null);

  return (
    <div className="flex flex-col gap-4" style={{ maxWidth: 760 }}>
      <PageHead title="Балансировщик" sub="Строки подписки в приложениях пользователей">
        <div className="flex items-center gap-2">
          <button className="icon-btn" onClick={() => void load()} title="Обновить из Remnawave" aria-label="Обновить"><RefreshCw size={16} /></button>
          <button className="btn" onClick={() => setPreview(true)}><Eye size={15} /> Проверить</button>
          <button className="btn solid" disabled={busy || s.groups.length >= st.limits.groups || active.length === 0}
            onClick={() => setEdit({ id: newId(), name: '', hosts: [], whitelist: false, description: '', template_uuid: null })}><Plus size={15} /> Хост</button>
        </div>
      </PageHead>

      {problem && (
        <div className="flex items-start gap-2" style={{ fontSize: 13, color: 'var(--danger)', lineHeight: 1.5 }}>
          <AlertTriangle size={15} style={{ flex: 'none', marginTop: 2 }} /> {problem}
        </div>
      )}

      <div className="card" style={{ padding: 6 }}>
        <Row icon={<Zap size={16} />} accent title={s.auto_group_name} sub={`Лучший из ${hostsWord(active.length)}`} onClick={() => setEdit('auto')} />
        {s.groups.map((g) => {
          const alive = g.hosts.filter((u) => byUuid[u] && !byUuid[u].disabled);
          const names = g.hosts.map((u) => byUuid[u]?.remark).filter(Boolean) as string[];
          return (
            <Row key={g.id} title={g.name} dim={!alive.length}
              icon={g.whitelist ? <ShieldCheck size={16} style={{ color: 'var(--accent)' }} /> : <span style={{ width: 16 }} />}
              sub={[g.description, alive.length ? (names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ')) : 'все серверы выключены'].filter(Boolean).join(' · ')}
              onClick={() => setEdit(g)} />
          );
        })}
      </div>

      <div className="faint" style={{ fontSize: 12, lineHeight: 1.6, padding: '0 4px' }}>
        {s.groups.length > 0 && active.some((h) => !inGroups.has(h.uuid)) ? `Серверов Remnawave вне хостов: ${active.filter((h) => !inGroups.has(h.uuid)).length} — они работают только в авто-выборе.` : null}
        {st.duplicates.length > 0 && <div style={{ color: 'var(--accent)' }}>Одинаковые названия в Remnawave: {st.duplicates.join(', ')} — переименуйте, иначе их нельзя выбрать.</div>}
        {st.last_sync.warnings.map((w) => <div key={w} style={{ color: 'var(--accent)' }}>{w}</div>)}
      </div>

      {edit === 'auto' && (
        <AutoEditor st={st} busy={busy} onClose={() => setEdit(null)}
          onSave={async (name, tpl) => { if (await save({ ...s, auto_group_name: name, auto_template_uuid: tpl })) setEdit(null); }} />
      )}
      {edit && edit !== 'auto' && (
        <GroupEditor st={st} initial={edit} busy={busy} onClose={() => setEdit(null)}
          index={s.groups.findIndex((g) => g.id === edit.id)}
          onMove={(d) => move(edit.id, d)}
          onDelete={async () => {
            if (!window.confirm(`Удалить «${edit.name}»? Его серверы останутся в авто-выборе.`)) return;
            if (await save({ ...s, groups: s.groups.filter((g) => g.id !== edit.id) }, 'Удалено')) setEdit(null);
          }}
          onSave={async (g) => {
            const exists = s.groups.some((x) => x.id === g.id);
            if (await save({ ...s, groups: exists ? s.groups.map((x) => (x.id === g.id ? g : x)) : [...s.groups, g] })) setEdit(null);
          }} />
      )}
      {preview && <PreviewModal onToast={onToast} onClose={() => setPreview(false)} />}
    </div>
  );
};

const Row: React.FC<{ icon: React.ReactNode; title: string; sub: string; onClick: () => void; accent?: boolean; dim?: boolean }> = ({ icon, title, sub, onClick, accent, dim }) => (
  <button onClick={onClick} className="bal-row" style={{ opacity: dim ? 0.5 : 1 }}>
    <span style={{ width: 32, height: 32, borderRadius: 10, display: 'grid', placeItems: 'center', flex: 'none', background: accent ? 'var(--accent)' : 'transparent', color: accent ? '#fff' : undefined }}>{icon}</span>
    <span style={{ flex: 1, minWidth: 0 }}>
      <span style={{ display: 'block', fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
      {sub && <span className="faint" style={{ display: 'block', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{sub}</span>}
    </span>
    <ChevronRight size={16} className="faint" style={{ flex: 'none' }} />
  </button>
);

const TemplatePick: React.FC<{ st: State; value: string | null; onChange: (v: string | null) => void }> = ({ st, value, onChange }) => (
  <div>
    <label className="field-label">Шаблон Xray JSON</label>
    {st.templates === null ? (
      <div className="faint" style={{ fontSize: 13 }}>Шаблоны из Remnawave сейчас недоступны{value ? ' — выбранный сохранится' : ''}.</div>
    ) : (
      <select className="input" value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Нет — настройки серверов из Remnawave</option>
        {value && !st.templates.some((t) => t.uuid === value) && <option value={value}>Удалён в Remnawave</option>}
        {st.templates.map((t) => <option key={t.uuid} value={t.uuid}>{t.name}</option>)}
      </select>
    )}
  </div>
);

const Foot: React.FC<{ left?: React.ReactNode; busy: boolean; onClose: () => void; onSave: () => void; label: string }> = ({ left, busy, onClose, onSave, label }) => (
  <>
    <div className="flex gap-1" style={{ flex: 1 }}>{left}</div>
    <button className="btn" onClick={onClose}>Отмена</button>
    <button className="btn solid" disabled={busy} onClick={onSave}>{busy ? <Spinner size={15} /> : <Check size={15} />} {label}</button>
  </>
);

const AutoEditor: React.FC<{ st: State; busy: boolean; onClose: () => void; onSave: (name: string, tpl: string | null) => void }> = ({ st, busy, onClose, onSave }) => {
  const [name, setName] = useState(st.settings.auto_group_name);
  const [tpl, setTpl] = useState(st.settings.auto_template_uuid);
  return (
    <Modal onClose={onClose} width={480} icon={Zap} title="Авто-выбор"
      footer={<Foot busy={busy} onClose={onClose} label="Сохранить" onSave={() => name.trim() && onSave(name.trim(), tpl)} />}>
      <div className="flex flex-col gap-4">
        <div className="sub" style={{ fontSize: 13, lineHeight: 1.5 }}>Первая строка подписки. Клиент сам выбирает самый быстрый сервер из всех; белые списки — только если обычные не отвечают.</div>
        <div>
          <label className="field-label">Название</label>
          <input className="input" value={name} maxLength={st.limits.name} onChange={(e) => setName(e.target.value)} />
        </div>
        <TemplatePick st={st} value={tpl} onChange={setTpl} />
      </div>
    </Modal>
  );
};

const GroupEditor: React.FC<{
  st: State; initial: Group; index: number; busy: boolean;
  onClose: () => void; onSave: (g: Group) => void; onDelete: () => void; onMove: (d: -1 | 1) => void;
}> = ({ st, initial, index, busy, onClose, onSave, onDelete, onMove }) => {
  const [g, setG] = useState<Group>(initial);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const isNew = index < 0;
  const owner: Record<string, string> = {};
  st.settings.groups.forEach((x) => { if (x.id !== g.id) x.hosts.forEach((u) => { owner[u] = x.name; }); });
  const known = new Set(st.hosts.map((h) => h.uuid));
  const sel = new Set(g.hosts);
  const ql = q.trim().toLocaleLowerCase();
  const list = st.hosts.filter((h) => !ql || h.remark.toLocaleLowerCase().includes(ql) || h.address.includes(ql));

  const done = () => {
    const name = g.name.trim();
    const hosts = g.hosts.filter((u) => known.has(u));
    const taken = [st.settings.auto_group_name, ...st.settings.groups.filter((x) => x.id !== g.id).map((x) => x.name)];
    if (!name) return setErr('Укажите название');
    if (taken.some((n) => n.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) return setErr('Такое название уже есть');
    if (!hosts.length) return setErr('Выберите хотя бы один сервер');
    return onSave({ ...g, name, hosts, description: g.description.trim() });
  };

  return (
    <Modal onClose={onClose} width={560} title={isNew ? 'Новый хост' : g.name || 'Хост'}
      footer={<Foot busy={busy} onClose={onClose} onSave={done} label={isNew ? 'Добавить' : 'Сохранить'}
        left={!isNew && <>
          <button className="icon-btn danger" disabled={busy} onClick={onDelete} title="Удалить" aria-label="Удалить"><Trash2 size={15} /></button>
          <button className="icon-btn" disabled={busy || index === 0} onClick={() => onMove(-1)} title="Выше в списке" aria-label="Выше"><ArrowUp size={15} /></button>
          <button className="icon-btn" disabled={busy || index === st.settings.groups.length - 1} onClick={() => onMove(1)} title="Ниже в списке" aria-label="Ниже"><ArrowDown size={15} /></button>
        </>} />}>
      <div className="flex flex-col gap-4">
        <div>
          <label className="field-label">Название</label>
          <input className="input" autoFocus={isNew} value={g.name} maxLength={st.limits.name} placeholder="🇩🇪 Германия" onChange={(e) => { setErr(''); setG({ ...g, name: e.target.value }); }} />
        </div>

        <div>
          <label className="field-label">Серверы Remnawave{g.hosts.length ? ` · ${g.hosts.filter((u) => known.has(u)).length}` : ''}</label>
          {st.hosts.length > 8 && (
            <div style={{ position: 'relative', marginBottom: 6 }}>
              <Search size={14} className="faint" style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)' }} />
              <input className="input" style={{ paddingLeft: 32 }} placeholder="Поиск" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
          <div className="inset" style={{ maxHeight: 240, overflowY: 'auto', padding: 4 }}>
            {list.length === 0 && <div className="faint" style={{ padding: 12, fontSize: 13, textAlign: 'center' }}>Ничего нет</div>}
            {list.map((h) => {
              const on = sel.has(h.uuid);
              const why = owner[h.uuid] ? `в «${owner[h.uuid]}»` : (st.duplicates.includes(h.remark) && !h.disabled) ? 'дубль названия' : h.disabled ? 'выключен' : '';
              const can = on || !(owner[h.uuid] || (st.duplicates.includes(h.remark) && !h.disabled));
              return (
                <label key={h.uuid} className="flex items-center gap-3" style={{ padding: '7px 10px', borderRadius: 8, cursor: can ? 'pointer' : 'default', opacity: can ? 1 : 0.4 }}>
                  <input type="checkbox" checked={on} disabled={!can} style={{ accentColor: 'var(--accent)', width: 16, height: 16, flex: 'none' }}
                    onChange={() => { setErr(''); setG({ ...g, hosts: on ? g.hosts.filter((x) => x !== h.uuid) : [...g.hosts, h.uuid] }); }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.remark || h.address}</span>
                  {why && <span className="faint" style={{ fontSize: 12, flex: 'none' }}>{why}</span>}
                </label>
              );
            })}
          </div>
        </div>

        <label className="flex items-center gap-3" style={{ cursor: 'pointer' }}>
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>Белые списки</span>
            <span className="faint" style={{ display: 'block', fontSize: 12, lineHeight: 1.45 }}>В авто-выборе — только если обычные серверы не отвечают</span>
          </span>
          <Toggle on={g.whitelist} onChange={() => setG({ ...g, whitelist: !g.whitelist })} />
        </label>

        <div>
          <label className="field-label">Описание <span className="faint">· {g.description.length}/{st.limits.description}</span></label>
          <input className="input" value={g.description} maxLength={st.limits.description} placeholder="Необязательно, например «Работает Gemini»" onChange={(e) => setG({ ...g, description: e.target.value })} />
        </div>

        <TemplatePick st={st} value={g.template_uuid} onChange={(v) => setG({ ...g, template_uuid: v })} />
        {err && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</div>}
      </div>
    </Modal>
  );
};

/** Настоящая подписка пользователя через XBM. */
const PreviewModal: React.FC<{ onToast: Toast; onClose: () => void }> = ({ onToast, onClose }) => {
  const [uid, setUid] = useState('');
  const [pv, setPv] = useState<Loc[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!Number(uid)) return;
    setBusy(true); setPv(null);
    try { setPv((await apiFetch(`/panel/xbm/preview?user_id=${Number(uid)}`)).locations); }
    catch (e) { onToast('Проверка', parseApiErr(e, 'Не удалось'), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose} width={480} icon={Eye} title="Проверить подписку">
      <div className="sub" style={{ fontSize: 13, marginBottom: 10 }}>Как подписку пользователя сейчас получает Happ.</div>
      <div className="flex gap-2">
        <input className="input" autoFocus inputMode="numeric" placeholder="ID пользователя" value={uid}
          onChange={(e) => setUid(e.target.value.replace(/\D/g, '').slice(0, 12))} onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} />
        <button className="btn solid" disabled={!uid || busy} onClick={() => void run()}>{busy ? <Spinner size={15} /> : 'Показать'}</button>
      </div>
      {pv && (
        <div className="inset" style={{ marginTop: 12, padding: 4 }}>
          {pv.map((l, i) => (
            <div key={i} style={{ padding: '9px 10px', borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{l.name}{l.description && <span className="faint" style={{ fontWeight: 400, fontSize: 12 }}> · {l.description}</span>}</div>
              <div className="faint" style={{ fontSize: 12, marginTop: 2, wordBreak: 'break-word' }}>
                {l.servers.join(', ')}{l.reserve.length > 0 && <span style={{ color: 'var(--accent)' }}> · резерв: {l.reserve.join(', ')}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
};
