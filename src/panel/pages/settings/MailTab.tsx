import React, { useEffect, useState } from 'react';
import { Check, Mail, RefreshCw, Send, Server, X } from 'lucide-react';
import { PageHead, Spinner } from '../../components/ui';
import { CopyBtn, Err, HowTo, Steps } from '../../components/Steps';
import { apiFetch, parseApiErr } from '../../lib/api';
import type { ToastType } from '../../lib/types';

type Cfg = { mode: 'off' | 'smtp' | 'direct'; host: string; port: number; user: string; has_password: boolean; domain: string; from: string; server_ip: string };
type Provider = 'yandex' | 'mailru' | 'gmail' | 'other';
type Rec = { type: string; host: string; value: string; ok: boolean };

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'yandex', label: 'Яндекс' }, { id: 'mailru', label: 'Mail.ru' }, { id: 'gmail', label: 'Gmail' }, { id: 'other', label: 'Другой' },
];

const HOWTO: Record<Provider, React.ReactNode[]> = {
  yandex: [
    <>Откройте <a href="https://mail.yandex.ru/#setup/client" target="_blank" rel="noreferrer">настройки Яндекс Почты → «Почтовые программы»</a> и включите «С сервера imap.yandex.ru по протоколу IMAP» и «Пароли приложений и OAuth-токены». Сохраните.</>,
    <>Откройте <a href="https://id.yandex.ru/security/app-passwords" target="_blank" rel="noreferrer">id.yandex.ru → Пароли приложений</a> и нажмите «Создать пароль» → «Почта».</>,
    <>Назовите пароль «BlinVPN» и скопируйте его — он показывается один раз.</>,
  ],
  mailru: [
    <>Откройте <a href="https://id.mail.ru/security" target="_blank" rel="noreferrer">Mail.ru → Безопасность</a> → «Пароли для внешних приложений».</>,
    <>Нажмите «Добавить», назовите «BlinVPN», выберите «Полный доступ к Почте (IMAP, SMTP)».</>,
    <>Скопируйте пароль — он показывается один раз.</>,
  ],
  gmail: [
    <>Включите двухэтапную аутентификацию: <a href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noreferrer">myaccount.google.com → Безопасность</a>.</>,
    <>Откройте <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">myaccount.google.com/apppasswords</a>, введите «BlinVPN» и нажмите «Создать».</>,
    <>Скопируйте пароль из 16 букв.</>,
  ],
  other: [
    <>Узнайте у своего почтового сервиса адрес SMTP-сервера и порт (обычно 465 или 587).</>,
    <>Создайте пароль для приложений, если сервис это требует.</>,
  ],
};

export const MailSettingsTab: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [wizard, setWizard] = useState(false);
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<'smtp' | 'direct'>('smtp');
  const [prov, setProv] = useState<Provider>('yandex');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('465');
  const [user, setUser] = useState('');
  const [pwd, setPwd] = useState('');
  const [domain, setDomain] = useState('');
  const [records, setRecords] = useState<Rec[] | null>(null);
  const [port25, setPort25] = useState<boolean | null>(null);
  const [to, setTo] = useState('');
  const [sent, setSent] = useState(false);
  const [notArrived, setNotArrived] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = () => apiFetch('/panel/mail').then((c: Cfg) => { setCfg(c); setUser((u) => u || (c.mode === 'smtp' ? c.user : '')); setDomain((d) => d || c.domain || window.location.hostname.split('.').slice(-2).join('.')); })
    .catch((e) => onToast('Ошибка', parseApiErr(e, 'Не удалось загрузить'), 'error'));
  useEffect(() => { void load(); }, []);

  const call = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setErr('');
    try { await fn(); } catch (e) { setErr(parseApiErr(e, 'Не получилось')); } finally { setBusy(''); }
  };
  const smtpBody = () => ({ provider: prov === 'other' ? undefined : prov, host, port: Number(port), user, password: pwd || undefined });
  const start = () => { setWizard(true); setStep(0); setSent(false); setNotArrived(false); setErr(''); };
  const spin = (k: string) => (busy === k ? <Spinner size={15} /> : null);

  if (!cfg) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;

  const testStep = {
    title: 'Проверить письмом',
    body: <>
      <HowTo items={[<>Укажите свою почту и нажмите «Отправить» — настройки сохранятся, и придёт тестовое письмо.</>, <>Проверьте, что письмо пришло.</>]} />
      <div className="flex gap-2" style={{ maxWidth: 480 }}>
        <input className="input" type="email" placeholder="you@example.com" value={to} onChange={(e) => setTo(e.target.value.trim())} />
        <button className="btn solid" disabled={!!busy || !to} onClick={() => void call('send', async () => {
          await apiFetch('/panel/mail', { method: 'PUT', body: JSON.stringify(mode === 'smtp' ? { mode: 'smtp', ...smtpBody() } : { mode: 'direct', domain }) });
          await apiFetch('/panel/mail/send-test', { method: 'POST', body: JSON.stringify({ to }) });
          setSent(true); setNotArrived(false); void load();
        })}>{spin('send') || <Send size={15} />} Отправить</button>
      </div>
      {sent && !notArrived && (
        <div className="flex flex-col gap-2">
          <div style={{ fontWeight: 600 }}>Письмо пришло?</div>
          <div className="flex gap-2">
            <button className="btn solid" onClick={() => { setWizard(false); onToast('Почта настроена', '', 'success'); }}><Check size={15} /> Да, пришло</button>
            <button className="btn" onClick={() => setNotArrived(true)}><X size={15} /> Нет</button>
          </div>
        </div>
      )}
      {notArrived && (
        <HowTo items={mode === 'smtp' ? [
          <>Подождите минуту и загляните в папку «Спам».</>,
          <>Проверьте, что пароль — именно пароль приложения.</>,
          <>Не помогло — выберите другой почтовый ящик (шаг 2).</>,
        ] : [
          <>Загляните в папку «Спам» — пока DNS-записи не добавлены, письма часто попадают туда.</>,
          <>Проверьте DNS-записи на шаге 3 — все должны быть отмечены галочкой.</>,
          <>Не помогло — выберите «Почтовый ящик» на шаге 1: это надёжнее.</>,
        ]} />
      )}
    </>,
  };

  const smtpSteps = [
    {
      title: 'Где почтовый ящик',
      body: <>
        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
          {PROVIDERS.map((p) => <button key={p.id} className={`chip ${prov === p.id ? 'on' : ''}`} onClick={() => setProv(p.id)}>{p.label}</button>)}
        </div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Создайте пароль приложения</div>
        <HowTo items={HOWTO[prov]} />
        <div><button className="btn solid" onClick={() => setStep(2)}>Далее</button></div>
      </>,
    },
    {
      title: 'Вход в почту',
      body: <>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3" style={{ maxWidth: 560 }}>
          {prov === 'other' && <>
            <div><label className="field-label">SMTP-сервер</label><input className="input" value={host} placeholder="smtp.example.com" onChange={(e) => setHost(e.target.value.trim())} /></div>
            <div><label className="field-label">Порт</label><select className="input" value={port} onChange={(e) => setPort(e.target.value)}><option>465</option><option>587</option></select></div>
          </>}
          <div><label className="field-label">Адрес почты</label><input className="input" type="email" value={user} placeholder="name@yandex.ru" onChange={(e) => setUser(e.target.value.trim())} /></div>
          <div><label className="field-label">Пароль приложения</label><input className="input" type="password" autoComplete="new-password" value={pwd} placeholder={cfg.has_password && cfg.user === user && cfg.host.toLowerCase() === host.toLowerCase() ? '••••••••' : ''} onChange={(e) => setPwd(e.target.value)} /></div>
        </div>
        <div className="flex gap-2">
          <button className="btn solid" disabled={!!busy || !user} onClick={() => void call('login', async () => {
            await apiFetch('/panel/mail/login-test', { method: 'POST', body: JSON.stringify(smtpBody()) });
            setStep(3);
          })}>{spin('login')} Проверить вход</button>
          <button className="btn ghost" onClick={() => setStep(1)}>Назад</button>
        </div>
      </>,
    },
  ];

  const directSteps = [
    {
      title: 'Проверить порт 25',
      body: <>
        <HowTo items={[<>Письма напрямую уходят через исходящий порт 25 — многие хостинги его закрывают. Нажмите «Проверить».</>]} />
        <div className="flex gap-2">
          <button className="btn solid" disabled={!!busy} onClick={() => void call('p25', async () => {
            const r = await apiFetch('/panel/mail/port25', { method: 'POST' }); setPort25(r.open); if (r.open) setStep(2);
          })}>{spin('p25')} Проверить</button>
          <button className="btn ghost" onClick={() => setStep(0)}>Назад</button>
        </div>
        {port25 === false && <>
          <Err>Порт 25 закрыт хостингом.</Err>
          <HowTo items={[
            <>Напишите в поддержку хостинга: «Откройте, пожалуйста, исходящий порт 25 для сервера {cfg.server_ip || 'IP вашего сервера'}».</>,
            <>После ответа нажмите «Проверить» ещё раз — или выберите «Почтовый ящик» на шаге 1.</>,
          ]} />
        </>}
      </>,
    },
    {
      title: 'Добавить DNS-записи',
      body: <>
        <div className="flex gap-2 items-end" style={{ maxWidth: 480 }}>
          <div style={{ flex: 1 }}><label className="field-label">Домен писем</label><input className="input" value={domain} placeholder="example.com" onChange={(e) => setDomain(e.target.value.trim().toLowerCase())} /></div>
          <button className="btn" disabled={!!busy || !domain} onClick={() => void call('dns', async () => {
            const r = await apiFetch('/panel/mail/dns', { method: 'POST', body: JSON.stringify({ domain }) }); setRecords(r.records);
          })}>{spin('dns') || <RefreshCw size={15} />} {records ? 'Проверить записи' : 'Показать записи'}</button>
        </div>
        {records && <>
          <HowTo items={[
            <>Откройте управление DNS у регистратора домена {domain}.</>,
            <>Добавьте три TXT-записи ниже (хост и значение — кнопками «Скопировать»).</>,
            <>Попросите хостинг сделать обратную запись (PTR) для {cfg.server_ip || 'IP сервера'} → mail.{domain}.</>,
            <>Через 5–30 минут нажмите «Проверить записи».</>,
          ]} />
          <div className="flex flex-col gap-2">
            {records.map((r) => (
              <div key={r.host} className="inset flex items-center gap-3" style={{ padding: '8px 10px' }}>
                {r.ok ? <Check size={16} style={{ color: '#34d399', flex: 'none' }} /> : <X size={16} className="faint" style={{ flex: 'none' }} />}
                <span className="mono" style={{ width: 130, flex: 'none', fontSize: 13 }}>{r.type} {r.host}</span>
                <span className="mono faint" style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.value}</span>
                <CopyBtn text={r.host} label="Хост" /><CopyBtn text={r.value} label="Значение" />
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button className="btn solid" onClick={() => setStep(3)}>{records.every((r) => r.ok) ? 'Далее' : 'Далее без проверки'}</button>
            <button className="btn ghost" onClick={() => setStep(1)}>Назад</button>
          </div>
        </>}
      </>,
    },
  ];

  const status = cfg.mode === 'off' ? 'Выключена' : cfg.mode === 'smtp' ? `Через ${cfg.host} · ${cfg.user}` : `Напрямую с сервера · ${cfg.from}`;

  return (
    <div className="flex flex-col gap-4">
      <PageHead title="Почта">
        <span className={`badge ${cfg.mode === 'off' ? 'line' : 'solid'}`}>{cfg.mode === 'off' ? 'Выключена' : 'Включена'}</span>
      </PageHead>

      {!wizard ? (
        <div className="card flex flex-col gap-3" style={{ padding: 20 }}>
          <div className="flex items-center gap-3"><Mail size={18} className="faint" /><span style={{ fontWeight: 600 }}>{status}</span></div>
          <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
            <button className="btn solid" onClick={start}>{cfg.mode === 'off' ? 'Настроить' : 'Изменить'}</button>
            {cfg.mode !== 'off' && <button className="btn danger" disabled={!!busy} onClick={() => void call('off', async () => {
              if (!window.confirm('Выключить почту? Вход на сайт по почте перестанет работать.')) return;
              await apiFetch('/panel/mail', { method: 'PUT', body: JSON.stringify({ mode: 'off' }) }); void load();
            })}>Выключить</button>}
          </div>
          {cfg.mode !== 'off' && (
            <div className="flex gap-2" style={{ maxWidth: 480, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <input className="input" type="email" placeholder="Тестовое письмо на…" value={to} onChange={(e) => setTo(e.target.value.trim())} />
              <button className="btn" disabled={!!busy || !to} onClick={() => void call('send', async () => {
                await apiFetch('/panel/mail/send-test', { method: 'POST', body: JSON.stringify({ to }) });
                onToast('Письмо отправлено', to, 'success');
              })}>{spin('send') || <Send size={15} />} Отправить</button>
            </div>
          )}
        </div>
      ) : (
        <>
          <Steps current={step} steps={[
            {
              title: 'Как отправлять письма',
              body: <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {([['smtp', Mail, 'Почтовый ящик', 'Яндекс, Mail.ru, Gmail. Проще всего'], ['direct', Server, 'Напрямую с сервера', 'Нужен открытый порт 25 и DNS-записи']] as const).map(([id, Icon, t, sub]) => (
                    <button key={id} className="inset" onClick={() => setMode(id)}
                      style={{ textAlign: 'left', padding: 14, cursor: 'pointer', color: 'inherit', font: 'inherit', border: `1px solid ${mode === id ? 'var(--accent)' : 'var(--border)'}` }}>
                      <div className="flex items-center gap-2" style={{ fontWeight: 600 }}><Icon size={16} /> {t}</div>
                      <div className="sub" style={{ fontSize: 13, marginTop: 4 }}>{sub}</div>
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <button className="btn solid" onClick={() => setStep(1)}>Далее</button>
                  <button className="btn ghost" onClick={() => setWizard(false)}>Отмена</button>
                </div>
              </>,
            },
            ...(mode === 'smtp' ? smtpSteps : directSteps),
            testStep,
          ]} />
          {err && <Err>{err}</Err>}
        </>
      )}
      {!wizard && err && <Err>{err}</Err>}
    </div>
  );
};
