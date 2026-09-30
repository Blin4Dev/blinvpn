import React, { useState, useEffect } from 'react';
import {
  Users, Mail, Plus, Send,
} from 'lucide-react';
import { Modal, PageHead, Spinner, Stat } from '../components/ui';
import { apiFetch } from '../lib/api';
import { fmtInt } from '../lib/format';
import type { ToastType } from '../lib/types';

export const MailingPage: React.FC<{ onToast: (t: string, m: string, ty: ToastType) => void }> = ({ onToast }) => {
  const [stats, setStats] = useState<{ totalSent: number } | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [message, setMessage] = useState('');
  const [buttonType, setButtonType] = useState('');
  const [buttonLabel, setButtonLabel] = useState('');
  const [buttonUrl, setButtonUrl] = useState('');
  const [promoCode, setPromoCode] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [targetUsers, setTargetUsers] = useState('all');
  const [chTelegram, setChTelegram] = useState(true);
  const [chEmail, setChEmail] = useState(false);
  const [subject, setSubject] = useState('');
  const [isSending, setIsSending] = useState(false);

  const loadHistory = async () => { try { const d = await apiFetch('/panel/mailing/history'); if (Array.isArray(d)) setHistory(d); } catch (e) { console.error(e); } };
  const loadStats = async () => { try { const d = await apiFetch('/panel/mailing/stats'); if (d) setStats(d); } catch (e) { console.error(e); } };

  useEffect(() => { loadStats(); loadHistory(); }, []);
  useEffect(() => {
    if (!history.some((i) => i.status === 'Sending' || i.status === 'Deleting')) return;
    const timer = setInterval(() => { loadHistory(); loadStats(); }, 4000);
    return () => clearInterval(timer);
  }, [history]);

  const handleSend = async () => {
    if (!message.trim()) { onToast('Ошибка', 'Введите текст сообщения', 'error'); return; }
    if ((buttonType === 'external_link' || buttonType === 'open_miniapp') && (!buttonLabel.trim() || !buttonUrl.trim())) { onToast('Ошибка', 'Укажите текст кнопки и ссылку', 'error'); return; }
    if (buttonType === 'activate_promo' && !promoCode.trim()) { onToast('Ошибка', 'Укажите промокод', 'error'); return; }
    const channels = [chTelegram && 'telegram', chEmail && 'email'].filter(Boolean) as string[];
    if (channels.length === 0) { onToast('Ошибка', 'Выберите хотя бы один канал', 'error'); return; }
    if (chEmail && !subject.trim()) { onToast('Ошибка', 'Укажите тему письма для email-рассылки', 'error'); return; }
    if (!confirm('Запустить рассылку?')) return;
    setIsSending(true);
    try {
      const payload: any = { message, target_users: targetUsers, title: message.substring(0, 50), channels };
      if (chEmail) payload.subject = subject.trim();
      if (buttonType === 'external_link' || buttonType === 'open_miniapp') { payload.button_type = buttonType; payload.button_value = `${buttonLabel.trim()}|${buttonUrl.trim()}`; }
      else if (buttonType === 'activate_promo') { payload.button_type = buttonType; payload.button_value = promoCode.trim(); }
      if (imageUrl.trim()) payload.image_url = imageUrl.trim();
      await apiFetch('/panel/mailing', { method: 'POST', body: JSON.stringify(payload) });
      onToast('Рассылка', 'Запущена и отправляется в фоне', 'success');
      setMessage(''); setButtonType(''); setButtonLabel(''); setButtonUrl(''); setPromoCode(''); setImageUrl(''); setSubject('');
      loadStats(); loadHistory();
    } catch (e: any) { let m = 'Не удалось запустить рассылку'; try { const p = JSON.parse(e?.message || ''); m = p?.detail?.message || m; } catch {} onToast('Ошибка', m, 'error'); } finally { setIsSending(false); }
  };

  const targets = [{ v: 'all', l: 'Все' }, { v: 'active', l: 'Активные' }, { v: 'expired', l: 'Истёкшие' }, { v: 'no_subscription', l: 'Без подписки' }];
  const historyBadge = (s: string) => s === 'Completed' ? { cls: 'solid', label: 'Отправлено' } : s === 'Sending' ? { cls: 'mute', label: 'Отправляется' } : s === 'Deleting' ? { cls: 'mute', label: 'Удаляется у пользователей' } : s === 'Cancelled' ? { cls: 'danger', label: 'Отменено' } : s === 'Interrupted' ? { cls: 'danger', label: 'Прервана (перезапуск)' } : { cls: 'line', label: s };

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Рассылка" sub="Массовая отправка сообщений" />
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Stat title="Отправлено сообщений" value={stats ? fmtInt(stats.totalSent) : '—'} icon={Send} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 card" style={{ padding: 24 }}>
          <h3 className="h-sec mb-4 flex items-center gap-2"><Plus size={18} className="faint" /> Новая рассылка</h3>
          <div className="flex flex-col gap-4">
            <div>
              <label className="field-label">Каналы</label>
              <div className="flex gap-2">
                <button type="button" className={`nav-item ${chTelegram ? 'on' : ''}`} style={{ flex: 1, justifyContent: 'center' }} onClick={() => setChTelegram(!chTelegram)}><Send size={15} /> Telegram</button>
                <button type="button" className={`nav-item ${chEmail ? 'on' : ''}`} style={{ flex: 1, justifyContent: 'center' }} onClick={() => setChEmail(!chEmail)}><Mail size={15} /> Почта</button>
              </div>
            </div>
            {chEmail && <div><label className="field-label">Тема письма</label><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Например: Новости BlinVPN" /></div>}
            <div><label className="field-label">Текст сообщения</label><textarea className="textarea" style={{ minHeight: 128 }} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Текст рассылки… Поддерживается Markdown" /></div>
            <div><label className="field-label">Тип кнопки</label>
              <select className="select" value={buttonType} onChange={(e) => { setButtonType(e.target.value); setButtonLabel(''); setButtonUrl(''); setPromoCode(''); }}>
                <option value="">Без кнопки</option><option value="external_link">Сторонняя ссылка</option><option value="open_miniapp">Открыть мини-приложение</option><option value="activate_promo">Активировать промокод</option>
              </select>
            </div>
            {(buttonType === 'external_link' || buttonType === 'open_miniapp') && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div><label className="field-label">Текст на кнопке</label><input className="input" value={buttonLabel} onChange={(e) => setButtonLabel(e.target.value)} placeholder={buttonType === 'open_miniapp' ? 'Открыть' : 'Перейти'} /></div>
                <div><label className="field-label">Ссылка</label><input className="input" value={buttonUrl} onChange={(e) => setButtonUrl(e.target.value)} placeholder="https://example.com" /></div>
              </div>
            )}
            {buttonType === 'activate_promo' && <div><label className="field-label">Промокод</label><input className="input mono" value={promoCode} onChange={(e) => setPromoCode(e.target.value)} placeholder="PROMOCODE" /></div>}
            <div>
              <label className="field-label">Картинка (URL, опционально)</label>
              <input className="input" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…/image.jpg" />
              <div className="faint mt-1" style={{ fontSize: 12 }}>Форматирование: &lt;b&gt;, &lt;i&gt;, &lt;code&gt;, **жирный**, *курсив*, `моно`; premium-emoji: ![ID]</div>
            </div>
            <div>
              <label className="field-label">Получатели</label>
              <div className="flex flex-wrap gap-2">
                {targets.map((t) => <button key={t.v} className={`chip ${targetUsers === t.v ? 'on' : ''}`} onClick={() => setTargetUsers(t.v)}>{t.l}</button>)}
              </div>
            </div>
            <button className="btn solid block" onClick={handleSend} disabled={isSending} style={{ padding: 12 }}>{isSending ? <><Spinner size={16} /> Запуск…</> : <><Send size={16} /> Отправить</>}</button>
          </div>
        </div>

        <div className="tbl-wrap" style={{ display: 'flex', flexDirection: 'column', maxHeight: 620 }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}><h3 className="h-sec">История</h3></div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {history.length === 0 ? <div className="sub" style={{ padding: 16, textAlign: 'center' }}>Нет рассылок</div>
              : history.map((item) => {
                  const b = historyBadge(item.status);
                  return (
                    <div key={item.id} style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
                      <div className="flex justify-between items-start gap-2 mb-2">
                        <span className="line-clamp-1" style={{ fontWeight: 500 }}>{item.title || 'Без названия'}</span>
                        <span className="faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{item.date}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className={`badge ${b.cls}`}>{b.label}</span>
                        <span className="sub flex items-center gap-1"><Users size={12} /> {item.sent_count || 0}</span>
                      </div>
                      <div className="flex gap-2 mt-3">
                        <button className="btn sm" onClick={() => setSelected(item)}>Открыть</button>
                        {item.status !== 'Deleting' && <button className="btn sm danger" onClick={async () => {
                          const hasEmail = String(item.channel || '').includes('email');
                          const text = 'Удалить рассылку?\n\n'
                            + 'Сообщения в Telegram будут удалены у пользователей (Telegram позволяет это только в течение 48 часов после отправки).'
                            + (hasEmail ? '\n\nПисьма удалить нельзя: они уже в почтовых ящиках получателей.' : '')
                            + (item.status === 'Sending' ? '\n\nОтправка будет остановлена.' : '');
                          if (!confirm(text)) return;
                          try {
                            const r = await apiFetch(`/panel/mailing/${item.id}`, { method: 'DELETE' });
                            const n = Number(r?.telegram_messages || 0);
                            onToast('Удаление', n ? `Удаляем ${fmtInt(n)} сообщ. в Telegram` : 'Рассылка удалена', 'success');
                            loadHistory();
                          }
                          catch { onToast('Ошибка', 'Не удалось удалить', 'error'); }
                        }}>Удалить</button>}
                      </div>
                    </div>
                  );
                })}
          </div>
        </div>
      </div>

      {selected && (
        <Modal onClose={() => setSelected(null)} title={selected.title || 'Текст рассылки'} width={640} z={70}>
          <div className="inset mono" style={{ padding: 16, whiteSpace: 'pre-wrap', maxHeight: '60vh', overflow: 'auto', fontSize: 13 }}>{selected.message_text || 'Пустое сообщение'}</div>
        </Modal>
      )}
    </div>
  );
};
