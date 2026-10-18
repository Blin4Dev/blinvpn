import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MSIcon, PageHeader, Screen, T } from "../components/ui";
import RichText from "../components/RichText";
import { btnReset } from "../theme";
import { useSmartBack } from "../utils/navigation";
import {
  closeSupportTicket,
  fetchSupport,
  markSupportRead,
  sendSupportMessage,
  uploadSupportFile,
  type SupportFile,
  type SupportMessage,
  type SupportQuote,
  type SupportState,
  SUPPORT_PREFILL_KEY,
} from "../utils/api";

type Pending = {
  key: string;
  file: File;
  preview?: string;
  progress: number;
  id?: string;
  error?: string;
  abort?: () => void;
};

const POLL_MS = 4000;

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;
  if (n >= 1024) return `${Math.round(n / 1024)} КБ`;
  return `${n} Б`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Сегодня";
  if (same(d, y)) return "Вчера";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

// открыть файл в браузере tg (скачивание внутри приложения нестабильно)
function openExternal(url: string) {
  const abs = new URL(url, window.location.origin).toString();
  const tg = (window as unknown as { Telegram?: { WebApp?: { initData?: string; openLink?: (u: string) => void } } }).Telegram?.WebApp;
  if (tg?.initData && tg.openLink) tg.openLink(abs);
  else window.open(abs, "_blank", "noopener,noreferrer");
}

function Attachment({ f, mine, onImage, onMedia }: { f: SupportFile; mine: boolean; onImage: (url: string) => void; onMedia?: () => void }) {
  if (f.kind === "deleted") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 14, background: mine ? "rgba(0,0,0,0.18)" : T.surfaceRaised, opacity: 0.8 }}>
        <MSIcon name="hide_image" style={{ fontSize: 22 }} />
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 14, textDecoration: "line-through", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
          <span style={{ display: "block", fontSize: 12 }}>Файл больше недоступен</span>
        </span>
      </div>
    );
  }
  if (f.kind === "image") {
    return (
      <button type="button" onClick={() => onImage(f.url)} style={{ ...btnReset, border: "none", padding: 0, background: "transparent", display: "block", cursor: "zoom-in" }}>
        <img src={f.url} alt={f.name} onLoad={onMedia}
          style={{ display: "block", maxWidth: "100%", maxHeight: 260, borderRadius: 14, objectFit: "cover", background: "rgba(0,0,0,0.2)" }} />
      </button>
    );
  }
  if (f.kind === "video") {
    return <video src={f.url} controls playsInline preload="metadata" onLoadedMetadata={onMedia} style={{ display: "block", width: "100%", maxHeight: 280, borderRadius: 14, background: "#000" }} />;
  }
  return (
    <button type="button" onClick={() => openExternal(f.url)} className="blin-press"
      style={{
        ...btnReset, width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 14,
        border: "none", cursor: "pointer", textAlign: "left",
        background: mine ? "rgba(0,0,0,0.18)" : T.surfaceRaised, color: T.text,
      }}>
      <MSIcon name="description" style={{ fontSize: 22, color: mine ? "#fff" : T.orange }} />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "block", fontSize: 14, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
        <span style={{ display: "block", fontSize: 12, color: mine ? "rgba(255,255,255,0.75)" : T.textMuted }}>{fmtSize(f.size)} · скачать</span>
      </span>
    </button>
  );
}

function quoteText(q: SupportQuote): string {
  if (q.deleted) return "Сообщение удалено";
  return q.text || (q.files ? (q.files === 1 ? "📎 Вложение" : `📎 ${q.files} влож.`) : "");
}

function Bubble({ m, onImage, onMedia, onReply, onQuote, flash, onNoThanks, closing }: {
  m: SupportMessage; onImage: (url: string) => void; onMedia?: () => void;
  onReply: (m: SupportMessage) => void; onQuote: (id: number) => void; flash: boolean;
  onNoThanks: (m: SupportMessage) => void; closing: boolean;
}) {
  if (m.sender === "system") {
    // служебные события одной серой строкой-разделителем
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "8px 0", fontSize: 12, color: T.textMuted }}>
        <span style={{ flex: 1, height: 1, background: T.border }} />
        <span style={{ textAlign: "center", maxWidth: "70%" }}>{m.text}</span>
        <span style={{ flex: 1, height: 1, background: T.border }} />
      </div>
    );
  }
  const mine = m.sender === "user";
  return (
    <div data-mid={m.id} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "88%", display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, flexDirection: mine ? "row-reverse" : "row", maxWidth: "100%" }}>
        <div style={{
          background: mine ? T.orange : T.surface,
          border: mine ? "none" : `1px solid ${T.border}`,
          color: mine ? "#fff" : T.text,
          borderRadius: 18, borderBottomRightRadius: mine ? 6 : 18, borderBottomLeftRadius: mine ? 18 : 6,
          padding: m.files.length && !m.text && !m.reply_to ? 4 : "9px 13px",
          display: "flex", flexDirection: "column", gap: 6, minWidth: 0, maxWidth: "100%",
          boxShadow: flash ? `0 0 0 3px ${T.info}` : "none", transition: "box-shadow 0.3s",
        }}>
          {m.reply_to && (
            <button type="button" onClick={() => onQuote(m.reply_to!.id)}
              style={{ ...btnReset, textAlign: "left", border: "none", cursor: "pointer", padding: "5px 9px", borderRadius: 10, color: "inherit",
                borderLeft: `3px solid ${mine ? "rgba(255,255,255,0.7)" : T.orange}`, background: mine ? "rgba(0,0,0,0.14)" : T.surfaceRaised }}>
              <span style={{ display: "block", fontSize: 12, fontWeight: 600, opacity: 0.85 }}>
                {m.reply_to.deleted ? "" : m.reply_to.sender === "admin" ? "Поддержка" : "Вы"}
              </span>
              <span style={{ display: "block", fontSize: 13, opacity: 0.85, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 230 }}>
                {quoteText(m.reply_to)}
              </span>
            </button>
          )}
          {m.files.map((f) => <Attachment key={f.id} f={f} mine={mine} onImage={onImage} onMedia={onMedia} />)}
          {m.text && (
            <div style={{ fontSize: 15, lineHeight: "21px", wordBreak: "break-word", padding: m.files.length ? "2px 6px 2px" : 0 }}>
              <RichText text={m.text} tone={mine ? "chatOnAccent" : "chat"} compact />
            </div>
          )}
          {/* time inside bubble */}
          <span style={{ alignSelf: "flex-end", fontSize: 11, lineHeight: "13px", marginTop: -2, padding: m.files.length && !m.text ? "0 8px 4px" : 0,
            color: mine ? "rgba(255,255,255,0.75)" : T.textDim }}>{m.edited ? "изменено · " : ""}{fmtTime(m.created_at)}</span>
        </div>
        <button type="button" onClick={() => onReply(m)} aria-label="Ответить" className="blin-press"
          style={{ ...btnReset, flex: "none", width: 28, height: 28, borderRadius: 14, border: "none", background: "transparent", color: T.textDim, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0 }}>
          <MSIcon name="reply" style={{ fontSize: 18 }} />
        </button>
      </div>
      {/* close_prompt action under support msg */}
      {m.kind === "close_prompt" && m.action_active && (
        <button type="button" onClick={() => onNoThanks(m)} disabled={closing} className="blin-press"
          style={{ ...btnReset, alignSelf: "stretch", marginTop: 6, marginRight: 34, minWidth: 200, padding: "11px 16px",
            borderRadius: 14, border: `1px solid rgba(255, 107, 26, 0.55)`, background: T.orangeSoft,
            color: T.orangeBright, fontSize: 15, fontWeight: 600, cursor: closing ? "default" : "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8, opacity: closing ? 0.6 : 1 }}>
          <MSIcon name="check_circle" style={{ fontSize: 20, color: "inherit" }} />
          {closing ? "Закрываем…" : "Нет, спасибо"}
        </button>
      )}
    </div>
  );
}

export default function Support() {
  const goBack = useSmartBack("/");
  const [state, setState] = useState<SupportState | null>(null);
  const [error, setError] = useState("");
  const [text, setText] = useState(() => {
    try {
      const t = sessionStorage.getItem(SUPPORT_PREFILL_KEY) || "";
      sessionStorage.removeItem(SUPPORT_PREFILL_KEY);
      return t;
    } catch { return ""; }
  });
  const [pending, setPending] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const [viewer, setViewer] = useState<string | null>(null);
  const [reply, setReply] = useState<SupportMessage | null>(null);
  const [flashId, setFlashId] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const lastId = useRef(0);
  const stick = useRef(true);

  const merge = useCallback((incoming: SupportMessage[]) => {
    if (!incoming.length) return;
    setState((s) => {
      if (!s) return s;
      const have = new Set(s.messages.map((m) => m.id));
      const add = incoming.filter((m) => !have.has(m.id));
      if (!add.length) return s;
      // lastId двигает только опрос (иначе ответ поддержки прямо перед нашим пропадёт)
      return { ...s, messages: [...s.messages, ...add].sort((a, b) => a.id - b.id) };
    });
  }, []);

  const stateRef = useRef<SupportState | null>(null);
  stateRef.current = state;
  const reload = useCallback(() => {
    fetchSupport(0).then((s) => { lastId.current = s.messages.length ? s.messages[s.messages.length - 1].id : 0; setState(s); }).catch(() => {});
  }, []);

  // первичная загрузка
  useEffect(() => {
    let alive = true;
    fetchSupport(0)
      .then((s) => {
        if (!alive) return;
        lastId.current = s.messages.length ? s.messages[s.messages.length - 1].id : 0;
        setState(s);
        if (s.chat?.unread) void markSupportRead();
      })
      .catch((e: Error) => alive && setError(e.message || "Не удалось открыть чат"));
    return () => { alive = false; };
  }, []);

  // опрос новых сообщений
  useEffect(() => {
    if (!state) return;
    const t = window.setInterval(() => {
      fetchSupport(lastId.current)
        .then((s) => {
          const cur = stateRef.current;
          if (cur && (cur.ticket?.status !== s.ticket?.status)) {
            // тикет открыт/закрыт: полная перезагрузка (вопрос о закрытии мог исчезнуть)
            reload();
            if (s.messages.some((m) => m.sender !== "user")) void markSupportRead();
            return;
          }
          // поддержка изменила или удалила сообщение
          if (s.changes && s.changes.length) {
            const ch = new Map(s.changes.map((m) => [m.id, m]));
            setState((st) => {
              if (!st || !st.messages.some((m) => ch.has(m.id))) return st;
              const msgs = st.messages
                .filter((m) => !(ch.get(m.id) as { deleted?: boolean } | undefined)?.deleted)
                .map((m) => (ch.has(m.id) ? { ...m, ...ch.get(m.id)! } : m));
              return { ...st, messages: msgs };
            });
          }
          if (s.messages.length) {
            lastId.current = Math.max(lastId.current, ...s.messages.map((m) => m.id));
            merge(s.messages);
            if (s.messages.some((m) => m.sender !== "user")) void markSupportRead();
          }
        })
        .catch(() => { /* ignore */ });
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [state !== null, merge, reload]);

  // прокрутить вниз при новых, если уже внизу
  const keepBottom = useCallback(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, []);
  useLayoutEffect(() => { keepBottom(); }, [state?.messages.length, keepBottom]);

  const onScroll = () => {
    const el = listRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const limits = state?.limits || { max_file_mb: 50, max_files: 10, max_text: 4000 };

  const addFiles = (list: FileList | null) => {
    if (!list || !list.length) return;
    const room = limits.max_files - pending.length;
    const files = Array.from(list).slice(0, Math.max(0, room));
    if (list.length > room) setError(`Можно прикрепить не больше ${limits.max_files} файлов`);
    for (const file of files) {
      const key = `${Date.now()}-${Math.random()}`;
      if (file.size > limits.max_file_mb * 1024 * 1024) {
        setPending((p) => [...p, { key, file, progress: 0, error: `Больше ${limits.max_file_mb} МБ` }]);
        continue;
      }
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      const up = uploadSupportFile(file, (pr) => setPending((p) => p.map((x) => (x.key === key ? { ...x, progress: pr } : x))));
      setPending((p) => [...p, { key, file, preview, progress: 0, abort: up.abort }]);
      up.promise
        .then((res) => setPending((p) => p.map((x) => (x.key === key ? { ...x, id: res.id, progress: 1 } : x))))
        .catch((e: Error) => setPending((p) => p.map((x) => (x.key === key ? { ...x, error: e.message } : x))));
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const removePending = (key: string) => {
    setPending((p) => {
      const x = p.find((y) => y.key === key);
      if (x?.abort && !x.id && !x.error) x.abort();
      if (x?.preview) URL.revokeObjectURL(x.preview);
      return p.filter((y) => y.key !== key);
    });
  };

  const uploading = pending.some((p) => !p.id && !p.error);
  const ready = pending.filter((p) => p.id);
  const canSend = !sending && !uploading && (text.trim().length > 0 || ready.length > 0);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError("");
    try {
      const m = await sendSupportMessage(text.trim(), ready.map((p) => p.id as string), reply?.id);
      stick.current = true;
      if (!state?.chat) setState((s) => (s ? { ...s, chat: { id: 0, unread: 0 } } : s));
      // any reply clears «ещё помочь?» prompt
      setState((s) => (s ? { ...s, messages: s.messages.map((x) => (x.action_active ? { ...x, action_active: false } : x)) } : s));
      merge([m]);
      setText("");
      setReply(null);
      // first msg after close opens ticket; «нет, спасибо» closes
      if (state?.ticket?.status !== "open" || m.ticket_closed) reload();
      pending.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
      setPending((p) => p.filter((x) => x.error));
      if (taRef.current) taRef.current.style.height = "auto";
    } catch (e) {
      setError((e as Error).message || "Не удалось отправить");
    } finally {
      setSending(false);
    }
  };

  const onText = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value.slice(0, limits.max_text));
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(140, el.scrollHeight)}px`;
  };

  const msgs = state?.messages || [];
  const jumpTo = (id: number) => {
    const el = listRef.current?.querySelector(`[data-mid="${id}"]`) as HTMLElement | null;
    if (!el) return;
    stick.current = false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashId(id);
    window.setTimeout(() => setFlashId(null), 1400);
  };
  const noThanks = async (m: SupportMessage) => {
    if (closing) return;
    setClosing(true);
    setError("");
    try {
      await closeSupportTicket(m.id);
      stick.current = true;
    } catch (e) {
      setError((e as Error).message || "Не удалось закрыть обращение");
    } finally {
      reload();
      setClosing(false);
    }
  };
  const lastSys = msgs.length ? msgs[msgs.length - 1] : null;
  const closedNow = state?.ticket?.status === "closed" && lastSys?.sender === "system";

  return (
    <Screen scroll={false}>
      <PageHeader title="Поддержка" onBack={goBack} />

      <div ref={listRef} onScroll={onScroll} className="blin-scroll"
        style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, margin: "0 -26px", padding: "0 20px 12px" }}>
        {!state && !error && <div style={{ margin: "auto", color: T.textMuted, fontSize: 14 }}>Загрузка…</div>}
        {state && msgs.length === 0 && (
          <div style={{ margin: "auto", textAlign: "center", padding: "0 24px" }}>
            <div style={{ width: 64, height: 64, borderRadius: 20, background: T.orangeSoft, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <MSIcon name="support_agent" style={{ fontSize: 34, color: T.orange }} />
            </div>
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Напишите нам</div>
            <div style={{ fontSize: 14, lineHeight: "20px", color: T.textMuted }}>
              Опишите проблему — ответим прямо здесь. Можно прикрепить скриншот, видео или файл.
            </div>
          </div>
        )}
        {msgs.map((m, i) => {
          const showDay = i === 0 || new Date(msgs[i - 1].created_at).toDateString() !== new Date(m.created_at).toDateString();
          return (
            <React.Fragment key={m.id}>
              {showDay && <div style={{ alignSelf: "center", fontSize: 12, color: T.textDim, margin: "8px 0 2px" }}>{dayLabel(m.created_at)}</div>}
              <Bubble m={m} onImage={setViewer} onMedia={keepBottom} onQuote={jumpTo} flash={flashId === m.id}
                onReply={(x) => { setReply(x); taRef.current?.focus(); }} onNoThanks={noThanks} closing={closing} />
            </React.Fragment>
          );
        })}
      </div>

      {closedNow && (
        <div style={{ fontSize: 13, color: T.textMuted, textAlign: "center", padding: "6px 8px" }}>
          Обращение закрыто. Если вопрос остался — просто напишите, и мы откроем новое.
        </div>
      )}

      {reply && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", marginTop: 6, borderRadius: 12, background: T.surface, borderLeft: `3px solid ${T.orange}` }}>
          <MSIcon name="reply" style={{ fontSize: 20, color: T.orange }} />
          <div style={{ minWidth: 0, flex: 1 }} onClick={() => jumpTo(reply.id)}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.orange }}>{reply.sender === "admin" ? "Ответ поддержке" : "Ответ на ваше сообщение"}</div>
            <div style={{ fontSize: 13, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {reply.text || (reply.files.length ? `📎 ${reply.files[0].name}` : "")}
            </div>
          </div>
          <button type="button" onClick={() => setReply(null)} aria-label="Отменить ответ"
            style={{ ...btnReset, width: 28, height: 28, borderRadius: 14, border: "none", background: "transparent", color: T.textMuted, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0 }}>
            <MSIcon name="close" style={{ fontSize: 18 }} />
          </button>
        </div>
      )}

      {error && (
        <div style={{ fontSize: 13, color: T.danger, padding: "6px 2px" }} onClick={() => setError("")}>{error}</div>
      )}

      {pending.length > 0 && (
        <div style={{ display: "flex", gap: 8, overflowX: "auto", padding: "8px 0 4px" }}>
          {pending.map((p) => (
            <div key={p.key} style={{ position: "relative", flex: "none", width: 72, height: 72, borderRadius: 14, background: T.surface, border: `1px solid ${p.error ? T.danger : T.border}`, overflow: "hidden" }}>
              {p.preview ? <img src={p.preview} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", opacity: p.id ? 1 : 0.55 }} /> : (
                <div style={{ padding: 8, fontSize: 11, color: T.textMuted, lineHeight: "14px", wordBreak: "break-all" }}>
                  <MSIcon name={p.file.type.startsWith("video/") ? "movie" : "description"} style={{ fontSize: 20, color: T.orange }} />
                  <div style={{ overflow: "hidden", maxHeight: 28 }}>{p.file.name}</div>
                </div>
              )}
              {!p.id && !p.error && (
                <div style={{ position: "absolute", left: 6, right: 6, bottom: 6, height: 4, borderRadius: 2, background: "rgba(0,0,0,0.4)" }}>
                  <div style={{ width: `${Math.round(p.progress * 100)}%`, height: "100%", borderRadius: 2, background: T.orange }} />
                </div>
              )}
              {p.error && <div style={{ position: "absolute", inset: "auto 0 0 0", fontSize: 10, background: "rgba(0,0,0,0.7)", color: T.danger, padding: "2px 4px" }}>{p.error}</div>}
              <button type="button" onClick={() => removePending(p.key)} aria-label="Убрать"
                style={{ ...btnReset, position: "absolute", top: 4, right: 4, width: 22, height: 22, borderRadius: 11, border: "none", background: "rgba(0,0,0,0.6)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0 }}>
                <MSIcon name="close" style={{ fontSize: 16 }} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "flex-end", gap: 8, paddingTop: 8 }}>
        <input ref={fileRef} type="file" multiple style={{ display: "none" }} onChange={(e) => addFiles(e.target.files)} />
        <button type="button" onClick={() => fileRef.current?.click()} aria-label="Прикрепить файл" className="blin-press"
          style={{ ...btnReset, flex: "none", width: 46, height: 46, borderRadius: 16, border: `1px solid ${T.border}`, background: T.surface, color: T.textMuted, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <MSIcon name="attach_file" style={{ fontSize: 22, transform: "rotate(45deg)" }} />
        </button>
        <textarea ref={taRef} value={text} onChange={onText} rows={1} placeholder="Сообщение…"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(pointer: fine)").matches) { e.preventDefault(); void send(); } }}
          style={{
            ...btnReset, flex: 1, minWidth: 0, resize: "none", minHeight: 46, maxHeight: 140, padding: "12px 14px", borderRadius: 16,
            border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 15, lineHeight: "20px",
          }} />
        <button type="button" onClick={() => void send()} disabled={!canSend} aria-label="Отправить" className="blin-press"
          style={{ ...btnReset, flex: "none", width: 46, height: 46, borderRadius: 16, border: "none", background: canSend ? T.orange : T.surfaceRaised, color: canSend ? "#fff" : T.textDim, display: "flex", alignItems: "center", justifyContent: "center", cursor: canSend ? "pointer" : "default" }}>
          <MSIcon name={sending || uploading ? "hourglass_top" : "arrow_upward"} style={{ fontSize: 22 }} />
        </button>
      </div>

      {viewer && (
        <div onClick={() => setViewer(null)}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.92)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <img src={viewer} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 8 }} />
        </div>
      )}
    </Screen>
  );
}
