import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, GripVertical, PlugZap, Save, Copy, Check, RotateCcw, Settings2 } from 'lucide-react';
import { PageHead, Spinner, Toggle } from '../../components/ui';
import { apiFetch, parseApiErr } from '../../lib/api';
import type { ToastType } from '../../lib/types';

// всё описание платёжек приходит с сервера (payments_config.SPECS): новая платёжка появится здесь сама
type FieldType = 'text' | 'secret' | 'bool';
type FieldValue = string | boolean;
type FieldSpec = {
  name: string; label: string; type: FieldType; required: boolean; hint: string; placeholder: string;
  show_if: string | null; value: FieldValue; saved?: boolean; from_env?: boolean;
};
type Provider = {
  id: string; label: string; note: string; methods: string[]; configured: boolean; from_env: boolean;
  refunds: boolean; testable: boolean; webhook_url: string; webhook_label: string; fields: FieldSpec[];
};
type MethodRow = { id: string; label: string; icon: string; enabled: boolean; providers: { id: string; enabled: boolean }[]; active_provider: string | null };
type Cfg = { methods: MethodRow[]; providers: Provider[] };
type MethodForm = { enabled: boolean; order: string[]; on: Record<string, boolean> };
type Form = { methods: Record<string, MethodForm>; values: Record<string, Record<string, FieldValue>> };

const fromCfg = (c: Cfg): Form => ({
  methods: Object.fromEntries(c.methods.map((m) => [m.id, {
    enabled: m.enabled, order: m.providers.map((p) => p.id), on: Object.fromEntries(m.providers.map((p) => [p.id, p.enabled])),
  }])),
  values: Object.fromEntries(c.providers.map((p) => [p.id, Object.fromEntries(p.fields.map((f) => [f.name, f.type === 'secret' ? '' : f.value]))])),
});

// ── мелочи ───────────────────────────────────────────────────

type Tone = 'ok' | 'warn' | 'bad' | 'off';
const TONE_COLOR: Record<Tone, string> = { ok: '#3ecf8e', warn: '#f5b547', bad: 'var(--danger)', off: 'rgba(255,255,255,0.25)' };
const Dot: React.FC<{ tone: Tone }> = ({ tone }) => (
  <span style={{ width: 7, height: 7, borderRadius: 4, flex: 'none', display: 'inline-block', background: TONE_COLOR[tone] }} />
);

const CopyLine: React.FC<{ label: string; value: string }> = ({ label, value }) => {
  const [ok, setOk] = useState(false);
  return (
    <div className="md:col-span-2">
      <label className="field-label">{label}</label>
      <button type="button" className="inset flex items-center gap-2" title="Скопировать"
        onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setOk(true); setTimeout(() => setOk(false), 1400); }); }}
        style={{ width: '100%', padding: '9px 12px', cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}>
        <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
        <span style={{ flex: 'none', color: ok ? 'var(--accent)' : 'var(--faint)', display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
          {ok ? <><Check size={14} /> Скопировано</> : <Copy size={14} />}
        </span>
      </button>
    </div>
  );
};

const MethodIcon: React.FC<{ src: string; on: boolean }> = ({ src, on }) => (
  <span style={{
    width: 42, height: 42, borderRadius: 12, flex: 'none', display: 'grid', placeItems: 'center',
    background: 'var(--surface-active)', opacity: on ? 1 : 0.45, transition: 'opacity var(--t)',
  }}>
    <img src={src} alt="" style={{ width: 24, height: 24, objectFit: 'contain' }}
      onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
  </span>
);

// ── перетаскивание: тянем за «ручку», порядок меняется на лету ──

function useReorder(onMove: (from: number, to: number) => void) {
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const [dragging, setDragging] = useState<number | null>(null);
  const start = (idx: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    let cur = idx;
    setDragging(cur);
    const move = (ev: PointerEvent) => {
      const y = ev.clientY;
      for (let i = 0; i < rows.current.length; i++) {
        const el = rows.current[i];
        if (!el || i === cur) continue;
        const r = el.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        if ((i < cur && y < mid) || (i > cur && y > mid)) {
          onMove(cur, i); cur = i; setDragging(i);
          break;
        }
      }
    };
    const up = () => { setDragging(null); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return { rows, dragging, start };
}

// ── вкладка ──────────────────────────────────────────────────

export const PaymentsSettingsTab: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [base, setBase] = useState<Form | null>(null);
  const [f, setF] = useState<Form | null>(null);
  const [openMethod, setOpenMethod] = useState<string | null>(null);
  const [openProv, setOpenProv] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const fRef = useRef<Form | null>(null);
  fRef.current = f;

  const apply = (c: Cfg) => { const fm = fromCfg(c); setCfg(c); setBase(fm); setF(fm); };
  useEffect(() => {
    apiFetch('/panel/settings/payments').then(apply).catch((e) => onToast('Ошибка', parseApiErr(e, 'Не удалось загрузить'), 'error'));
  }, []);

  const move = (m: string, from: number, to: number) => {
    const cur = fRef.current;
    if (!cur) return;
    const order = [...cur.methods[m].order];
    const [x] = order.splice(from, 1);
    order.splice(to, 0, x);
    setF({ ...cur, methods: { ...cur.methods, [m]: { ...cur.methods[m], order } } });
  };
  const drag = useReorder((from, to) => { if (openMethod) move(openMethod, from, to); });

  const dirty = useMemo(() => !!f && !!base && JSON.stringify(f) !== JSON.stringify(base), [f, base]);
  if (!cfg || !f) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;

  const P: Record<string, Provider> = Object.fromEntries(cfg.providers.map((p) => [p.id, p]));
  const val = (p: string, name: string) => f.values[p]?.[name];
  const visible = (p: Provider, fl: FieldSpec) => !fl.show_if || !!val(p.id, fl.show_if);
  // ключи на сервере есть или их только что ввели
  const keyed = (id: string) => {
    const p = P[id];
    if (!p) return false;
    if (p.configured) return true;
    if (!p.fields.some((fl) => fl.required)) return false;
    return p.fields.filter((fl) => fl.required).every((fl) => !!String(val(id, fl.name) ?? '').trim() || !!fl.saved || !!fl.from_env);
  };
  const working = (m: string) => {
    const st = f.methods[m];
    return st.enabled ? st.order.filter((p) => st.on[p] && keyed(p)) : [];
  };

  const setMethod = (m: string, patch: Partial<MethodForm>) => setF({ ...f, methods: { ...f.methods, [m]: { ...f.methods[m], ...patch } } });
  const setVal = (p: string, name: string, v: FieldValue) => setF({ ...f, values: { ...f.values, [p]: { ...f.values[p], [name]: v } } });

  const save = async () => {
    setBusy('save');
    try {
      const providers: Record<string, Record<string, FieldValue>> = {};
      for (const p of cfg.providers) {
        const body: Record<string, FieldValue> = {};
        for (const fl of p.fields) {
          const v = f.values[p.id][fl.name];
          if (fl.type === 'secret') { if (String(v ?? '').trim()) body[fl.name] = String(v).trim(); }
          else body[fl.name] = v;
        }
        providers[p.id] = body;
      }
      const methods = Object.fromEntries(Object.entries(f.methods).map(([m, st]) => [m, { enabled: st.enabled, order: st.order, providers: st.on }]));
      const r: Cfg = await apiFetch('/panel/settings/payments', { method: 'PUT', body: JSON.stringify({ methods, providers }) });
      apply(r);
      onToast('Сохранено', 'Новые платежи пойдут по этим настройкам', 'success');
    } catch (e) {
      onToast('Не сохранено', parseApiErr(e, 'Ошибка'), 'error');
    } finally { setBusy(''); }
  };

  const test = async (id: string) => {
    setBusy(`test-${id}`);
    try {
      const r = await apiFetch(`/panel/settings/payments/test/${id}`, { method: 'POST' });
      onToast(P[id]?.label || 'Проверка', r.message || 'Работает', r.ok === false ? 'error' : 'success');
    } catch (e) {
      onToast(P[id]?.label || 'Проверка', parseApiErr(e, 'Не получилось'), 'error');
    } finally { setBusy(''); }
  };

  const methodState = (m: MethodRow): { tone: Tone; text: string } => {
    const st = f.methods[m.id];
    if (!st.enabled) return { tone: 'off', text: 'Выключен — в приложении не показывается' };
    const w = working(m.id);
    if (m.id === 'tg_stars') return w.length ? { tone: 'ok', text: 'Принимает ваш бот' } : { tone: 'bad', text: 'Не работает: в .env нет TELEGRAM_BOT_TOKEN' };
    if (!w.length) return { tone: 'bad', text: 'Нет включённой платёжки с ключами — способ скрыт' };
    const rest = w.slice(1).map((p) => P[p]?.label || p);
    return { tone: 'ok', text: `Через ${P[w[0]]?.label || w[0]}${rest.length ? ` · запасные: ${rest.join(', ')}` : ' · запасной нет'}` };
  };

  // поле настройки (функция, не компонент — иначе поле теряет фокус при вводе)
  const renderField = (p: Provider, fl: FieldSpec) => {
    const v = val(p.id, fl.name);
    if (fl.type === 'bool') {
      return (
        <label key={fl.name} className="md:col-span-2 flex items-center justify-between gap-3"
          style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, cursor: 'pointer' }}>
          <span>
            <div style={{ fontWeight: 500, fontSize: 14 }}>{fl.label}</div>
            {fl.hint && <div className="faint" style={{ fontSize: 12, marginTop: 2, lineHeight: 1.45 }}>{fl.hint}</div>}
          </span>
          <Toggle on={!!v} onChange={() => setVal(p.id, fl.name, !v)} />
        </label>
      );
    }
    const isSecret = fl.type === 'secret';
    const hint = isSecret && fl.saved ? 'Сохранён — оставьте пустым, чтобы не менять' : fl.from_env ? 'Сейчас берётся из .env' : '';
    return (
      <div key={fl.name}>
        <label className="field-label">{fl.label}</label>
        <input className={`input ${isSecret ? '' : 'mono'}`} type={isSecret ? 'password' : 'text'} value={String(v ?? '')}
          autoComplete={isSecret ? 'new-password' : 'off'}
          placeholder={isSecret && (fl.saved || fl.from_env) ? '••••••••••••' : fl.from_env ? 'из .env' : fl.placeholder}
          onChange={(e) => setVal(p.id, fl.name, e.target.value)} />
        {hint && <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>{hint}</div>}
      </div>
    );
  };

  const providerSettings = (p: Provider, method: string) => {
    const fields = p.fields.filter((fl) => visible(p, fl));
    const shared = p.methods.filter((m) => m !== method && f.methods[m]);
    return (
      <div style={{ padding: '4px 14px 16px 50px', animation: 'rise 0.16s ease' }} className="pay-prov-body">
        <div className="faint" style={{ fontSize: 12.5, lineHeight: 1.5, marginBottom: 12 }}>
          {p.note}{shared.length ? ` · ключи общие с «${shared.map((m) => cfg.methods.find((x) => x.id === m)?.label).join('», «')}»` : ''}
        </div>
        {p.id === 'stars' && !p.configured && (
          <div className="sub" style={{ fontSize: 13, color: 'var(--danger)', marginBottom: 12 }}>В .env не задан TELEGRAM_BOT_TOKEN.</div>
        )}
        {(fields.length > 0 || p.webhook_url) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {fields.map((fl) => renderField(p, fl))}
            {p.webhook_url && <CopyLine label={p.webhook_label || 'Адрес для уведомлений'} value={p.webhook_url} />}
          </div>
        )}
        {p.testable && (
          <div className="flex items-center gap-3" style={{ marginTop: fields.length ? 14 : 0, flexWrap: 'wrap' }}>
            <button className="btn" disabled={!!busy || !p.configured} onClick={() => void test(p.id)}>
              {busy === `test-${p.id}` ? <Spinner size={15} /> : <PlugZap size={15} />} Проверить
            </button>
            {!p.configured && p.fields.length > 0 && <span className="faint" style={{ fontSize: 12 }}>Сначала сохраните ключи</span>}
          </div>
        )}
      </div>
    );
  };

  const providerItem = (m: string, id: string, idx: number, count: number) => {
    const p = P[id];
    if (!p) return null;
    const st = f.methods[m];
    const on = !!st.on[id];
    const k = keyed(id);
    const w = working(m);
    const tone: Tone = !on ? 'off' : !k ? 'bad' : 'ok';
    const text = !on ? 'Выключена' : !k ? (id === 'stars' ? 'Нет токена бота' : 'Нужны ключи') : w[0] === id ? 'Основная' : 'Запасная';
    const expanded = openProv === `${m}:${id}`;
    const isDragging = drag.dragging === idx;
    const canDrag = count > 1;
    return (
      <div key={id} ref={(el) => { drag.rows.current[idx] = el; }} className="pay-prov"
        style={{
          borderRadius: 12, border: `1px solid ${isDragging ? 'var(--accent-line)' : 'var(--border)'}`,
          background: isDragging ? 'var(--surface-active)' : 'var(--surface-2)',
          boxShadow: isDragging ? '0 10px 30px rgba(0,0,0,0.45)' : 'none',
          transition: 'background var(--t), border-color var(--t)', position: 'relative', zIndex: isDragging ? 2 : 1,
        }}>
        <div className="flex items-center gap-2" style={{ padding: '10px 12px 10px 6px' }}>
          {canDrag ? (
            <span onPointerDown={drag.start(idx)} title="Перетащите, чтобы изменить порядок"
              style={{ cursor: 'grab', touchAction: 'none', color: 'var(--faint)', padding: '6px 2px', display: 'flex' }}>
              <GripVertical size={16} />
            </span>
          ) : <span style={{ width: 20 }} />}
          <span className="mono faint" style={{ width: 16, fontSize: 12, textAlign: 'center', flex: 'none' }}>{idx + 1}</span>
          <button type="button" onClick={() => setOpenProv(expanded ? null : `${m}:${id}`)} className="flex items-center gap-3"
            style={{ flex: 1, minWidth: 0, background: 'transparent', border: 0, padding: '2px 0', cursor: 'pointer', textAlign: 'left', color: 'inherit' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 600, fontSize: 14, opacity: on ? 1 : 0.6 }}>{p.label}</span>
              <span className="flex items-center gap-2" style={{ fontSize: 12, marginTop: 2, color: tone === 'bad' ? 'var(--danger)' : 'var(--muted)' }}>
                <Dot tone={tone} /> {text}
              </span>
            </span>
            {p.fields.length > 0 && (
              <span className="faint flex items-center gap-1" style={{ fontSize: 12, flex: 'none' }}>
                <Settings2 size={14} /><span className="hidden md:inline">Ключи</span>
                <ChevronDown size={14} style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform var(--t)' }} />
              </span>
            )}
          </button>
          {canDrag && (
            <span className="flex flex-col pay-arrows" style={{ flex: 'none' }}>
              <button type="button" className="pay-arrow" disabled={idx === 0} onClick={() => move(m, idx, idx - 1)} aria-label="Выше"><ChevronUp size={13} /></button>
              <button type="button" className="pay-arrow" disabled={idx === count - 1} onClick={() => move(m, idx, idx + 1)} aria-label="Ниже"><ChevronDown size={13} /></button>
            </span>
          )}
          <Toggle on={on} onChange={() => setMethod(m, { on: { ...st.on, [id]: !on } })} />
        </div>
        {expanded && providerSettings(p, m)}
      </div>
    );
  };

  const methodRow = (m: MethodRow, i: number) => {
    const st = f.methods[m.id];
    const s = methodState(m);
    const expanded = openMethod === m.id;
    return (
      <div key={m.id} style={{ borderTop: i ? '1px solid var(--border)' : 'none' }}>
        <div className="flex items-center gap-3" style={{ padding: '14px 18px' }}>
          <button type="button" onClick={() => { setOpenMethod(expanded ? null : m.id); setOpenProv(null); }} className="flex items-center gap-3"
            style={{ flex: 1, minWidth: 0, background: 'transparent', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', color: 'inherit' }}>
            <MethodIcon src={m.icon} on={st.enabled} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 600, fontSize: 15 }}>{m.label}</span>
              <span className="flex items-center gap-2" style={{ fontSize: 12.5, marginTop: 3, color: s.tone === 'bad' ? 'var(--danger)' : 'var(--muted)' }}>
                <Dot tone={s.tone} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.text}</span>
              </span>
            </span>
            <ChevronDown size={17} className="faint" style={{ flex: 'none', transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform var(--t)' }} />
          </button>
          <Toggle on={st.enabled} onChange={() => setMethod(m.id, { enabled: !st.enabled })} />
        </div>
        {expanded && (
          <div className="pay-expand" style={{ opacity: st.enabled ? 1 : 0.7 }}>
            {st.order.length > 1 && (
              <div className="faint" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
                Сверху — основная. Если она не ответит, платёж пойдёт через следующую включённую.
              </div>
            )}
            <div className="flex flex-col gap-2" style={{ userSelect: drag.dragging !== null ? 'none' : undefined }}>
              {st.order.map((id, idx) => providerItem(m.id, id, idx, st.order.length))}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-5" style={{ paddingBottom: dirty ? 84 : 0 }}>
      <PageHead title="Платежи" sub="Способы оплаты в приложении и платёжки, через которые они работают" />

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {cfg.methods.map((m, i) => methodRow(m, i))}
      </div>
      <div className="faint" style={{ fontSize: 12, lineHeight: 1.5, marginTop: -8 }}>
        Выключение касается только новых платежей — уведомления и возвраты по уже созданным продолжают работать.
      </div>

      {dirty && (
        <div style={{ position: 'sticky', bottom: 16, zIndex: 20, animation: 'rise 0.18s ease' }}>
          <div className="flex items-center gap-3" style={{
            padding: '12px 14px 12px 18px', borderRadius: 14, background: 'var(--surface)',
            border: '1px solid var(--border-strong)', boxShadow: '0 18px 50px rgba(0,0,0,0.6)', flexWrap: 'wrap',
          }}>
            <Dot tone="warn" />
            <span style={{ flex: 1, minWidth: 160, fontSize: 14 }}>Есть несохранённые изменения</span>
            <button className="btn ghost" disabled={!!busy} onClick={() => base && setF(base)}><RotateCcw size={15} /> Отменить</button>
            <button className="btn solid" disabled={!!busy} onClick={() => void save()}>
              {busy === 'save' ? <Spinner size={15} /> : <Save size={15} />} Сохранить
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
