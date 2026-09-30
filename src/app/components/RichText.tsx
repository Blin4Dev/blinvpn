import React from "react";
import { T } from "./ui";
import { openPayUrl } from "../utils/api";

/**
 * Безопасный показ оформленного текста (оферта, политика конфиденциальности).
 *
 * Понимает Markdown и HTML, но НИЧЕГО не вставляет как сырой HTML: текст
 * разбирается и собирается из React-элементов, неизвестные теги показываются
 * как обычный текст. Поэтому скрипт, iframe, onclick и т.п. выполниться не могут.
 *
 * Markdown: # / ## / ### заголовки, **жирный** и *жирный*, _курсив_, __подчёркнутый__,
 *   ~~зачёркнутый~~, `код`, [ссылка](https://…), списки «- » / «* » / «1. », цитата «> », линия «---».
 * HTML: <b> <strong> <i> <em> <u> <s> <del> <code> <a href="https://…"> <br> <p>
 *   <h1>–<h3> <ul> <ol> <li> <hr> <blockquote>.
 */

const SAFE_URL = /^(https?:\/\/|mailto:|tg:\/\/)[^\s"'<>]+$/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&laquo;/gi, "«")
    .replace(/&raquo;/gi, "»")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&amp;/gi, "&");
}

/** Блочные HTML-теги → строки в Markdown-виде (дальше разбираются общим кодом). */
function htmlBlocksToLines(src: string): string {
  let s = src.replace(/\r\n?/g, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<hr\s*\/?>/gi, "\n---\n");
  // атрибуты у тегов (class, style…) не нужны — отбрасываем, кроме href у ссылок
  s = s.replace(/<(p|h[1-3]|ul|ol|li|blockquote|b|strong|i|em|u|s|del|strike|code|br|hr)\s+[^<>]*?(\/?)>/gi, "<$1$2>");
  s = s.replace(/<h([1-3])\s*>([\s\S]*?)<\/h\1\s*>/gi, (_m, n: string, t: string) => `\n${"#".repeat(Number(n))} ${t.replace(/\n+/g, " ").trim()}\n`);
  s = s.replace(/<blockquote\s*>([\s\S]*?)<\/blockquote\s*>/gi, (_m, t: string) =>
    "\n" + t.trim().split("\n").map((l) => "> " + l).join("\n") + "\n");
  // Нумерованные списки: <ol><li>…</li></ol> → «1. …»
  s = s.replace(/<ol\s*>([\s\S]*?)<\/ol\s*>/gi, (_m, inner: string) => {
    let i = 0;
    return "\n" + inner.replace(/<li\s*>([\s\S]*?)<\/li\s*>/gi, (_x, t: string) => `\n${++i}. ${t.replace(/\n+/g, " ").trim()}`) + "\n";
  });
  s = s.replace(/<li\s*>([\s\S]*?)<\/li\s*>/gi, (_m, t: string) => `\n- ${t.replace(/\n+/g, " ").trim()}`);
  s = s.replace(/<\/?(ul|ol)\s*>/gi, "\n");
  s = s.replace(/<p\s*>([\s\S]*?)<\/p\s*>/gi, (_m, t: string) => `\n${t.trim()}\n\n`);
  return s;
}

/** lead: группа 1 — символ перед маркером (вместо просмотра назад, которого нет в старых iOS). */
type Rule = { re: RegExp; make: (m: RegExpExecArray, key: string) => React.ReactNode; lead?: boolean };

const linkStyle: React.CSSProperties = { color: T.orangeBright, textDecoration: "underline", cursor: "pointer" };
const codeStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, Menlo, monospace", fontSize: "0.92em", background: T.surfaceRaised,
  borderRadius: 6, padding: "1px 5px", color: T.text,
};

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  const url = decodeEntities(href.trim());
  if (!SAFE_URL.test(url)) return <>{children}</>;
  return (
    <a href={url} style={linkStyle} rel="noopener noreferrer" target="_blank"
      onClick={(e) => { if (/^https?:/i.test(url)) { e.preventDefault(); openPayUrl(url); } }}>
      {children}
    </a>
  );
}

const RULES: Rule[] = [
  // HTML
  { re: /<(b|strong)\s*>([\s\S]+?)<\/\1\s*>/i, make: (m, k) => <strong key={k} style={{ color: T.text, fontWeight: 600 }}>{inline(m[2], k)}</strong> },
  { re: /<(i|em)\s*>([\s\S]+?)<\/\1\s*>/i, make: (m, k) => <em key={k}>{inline(m[2], k)}</em> },
  { re: /<u\s*>([\s\S]+?)<\/u\s*>/i, make: (m, k) => <u key={k}>{inline(m[1], k)}</u> },
  { re: /<(s|del|strike)\s*>([\s\S]+?)<\/\1\s*>/i, make: (m, k) => <s key={k}>{inline(m[2], k)}</s> },
  { re: /<code\s*>([\s\S]+?)<\/code\s*>/i, make: (m, k) => <code key={k} style={codeStyle}>{decodeEntities(m[1])}</code> },
  { re: /<a\s+href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]+?)<\/a\s*>/i, make: (m, k) => <Link key={k} href={m[1] ?? m[2] ?? ""}>{inline(m[3], k)}</Link> },
  // Markdown
  { re: /`([^`\n]+)`/, make: (m, k) => <code key={k} style={codeStyle}>{m[1]}</code> },
  { re: /\[([^\]\n]+)\]\(([^)\s]+)\)/, make: (m, k) => <Link key={k} href={m[2]}>{inline(m[1], k)}</Link> },
  { re: /\*\*([^*\n]+?)\*\*/, make: (m, k) => <strong key={k} style={{ color: T.text, fontWeight: 600 }}>{inline(m[1], k)}</strong> },
  { re: /__([^_\n]+?)__/, make: (m, k) => <u key={k}>{inline(m[1], k)}</u> },
  { re: /~~([^~\n]+?)~~/, make: (m, k) => <s key={k}>{inline(m[1], k)}</s> },
  { re: /(^|[^\p{L}\p{N}*])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![\p{L}\p{N}*])/u, lead: true, make: (m, k) => <strong key={k} style={{ color: T.text, fontWeight: 600 }}>{inline(m[2], k)}</strong> },
  { re: /(^|[^\p{L}\p{N}_])_([^_\s](?:[^_\n]*[^_\s])?)_(?![\p{L}\p{N}_])/u, lead: true, make: (m, k) => <em key={k}>{inline(m[2], k)}</em> },
];

/**
 * Строчная разметка. Каждое правило ищется глобальным регэкспом от текущей позиции,
 * а найденное совпадение запоминается: пока его не «перешагнули», правило заново
 * не запускается. Так длинная строка разбирается за линейное число проходов.
 */
function inline(text: string, keyBase = "i"): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const res = RULES.map((r) => new RegExp(r.re.source, r.re.flags.includes("g") ? r.re.flags : r.re.flags + "g"));
  // для каждого правила — ближайшее найденное совпадение и где начинается сама разметка
  const cache: ({ m: RegExpExecArray; at: number } | null | undefined)[] = RULES.map(() => undefined);
  let pos = 0;
  let n = 0;
  while (pos < text.length) {
    let best = -1;
    let bestAt = Infinity;
    for (let i = 0; i < RULES.length; i++) {
      let c = cache[i];
      if (c === undefined || (c !== null && c.at < pos)) {
        // правилам с «символом перед маркером» даём заглянуть на один символ назад
        res[i].lastIndex = RULES[i].lead ? Math.max(0, pos - 1) : pos;
        const m = res[i].exec(text);
        c = m ? { m, at: m.index + (RULES[i].lead ? m[1].length : 0) } : null;
        if (c && c.at < pos) c = null;  // не может случиться, но на всякий случай — без зацикливания
        cache[i] = c;
      }
      if (c && c.at < bestAt) { bestAt = c.at; best = i; }
    }
    if (best < 0) { out.push(decodeEntities(text.slice(pos))); break; }
    const { m } = cache[best]!;
    if (bestAt > pos) out.push(decodeEntities(text.slice(pos, bestAt)));
    out.push(RULES[best].make(m, `${keyBase}.${n++}`));
    pos = m.index + m[0].length;
  }
  return out;
}

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; lines: string[] }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[]; start: number }
  | { t: "quote"; lines: string[] }
  | { t: "hr" };

function parseBlocks(src: string): Block[] {
  const lines = htmlBlocksToLines(src).split("\n");
  const blocks: Block[] = [];
  const last = () => blocks[blocks.length - 1];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const t = line.trim();
    if (!t) { blocks.push({ t: "p", lines: [] }); continue; }
    let m: RegExpMatchArray | null;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { blocks.push({ t: "hr" }); continue; }
    if ((m = t.match(/^(#{1,3})\s+(.+)$/))) { blocks.push({ t: "h", level: m[1].length, text: m[2].replace(/\s*#+$/, "") }); continue; }
    if ((m = t.match(/^[-•]\s+(.+)$/)) || (m = t.match(/^\*\s+(.+)$/))) {
      const b = last();
      if (b && b.t === "ul") b.items.push(m[1]); else blocks.push({ t: "ul", items: [m[1]] });
      continue;
    }
    if ((m = t.match(/^(\d{1,3})[.)]\s+(.+)$/))) {
      const b = last();
      if (b && b.t === "ol") b.items.push(m[2]); else blocks.push({ t: "ol", items: [m[2]], start: Number(m[1]) });
      continue;
    }
    if ((m = t.match(/^>\s?(.*)$/))) {
      const b = last();
      if (b && b.t === "quote") b.lines.push(m[1]); else blocks.push({ t: "quote", lines: [m[1]] });
      continue;
    }
    const b = last();
    if (b && b.t === "p" && b.lines.length) b.lines.push(line); else blocks.push({ t: "p", lines: [line] });
  }
  return blocks.filter((b) => !(b.t === "p" && b.lines.length === 0));
}

function withBreaks(lines: string[], key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  lines.forEach((l, i) => {
    if (i) out.push(<br key={`${key}.br${i}`} />);
    out.push(...inline(l, `${key}.${i}`));
  });
  return out;
}

export function RichText({ text, style }: { text: string; style?: React.CSSProperties }) {
  const blocks = parseBlocks(text || "");
  const hSize = [0, 19, 17, 15];
  return (
    <div style={{ fontSize: 14, lineHeight: "21px", color: T.textMuted, wordBreak: "break-word", ...style }}>
      {blocks.map((b, i) => {
        const k = `b${i}`;
        const mt = i === 0 ? 0 : undefined;
        switch (b.t) {
          case "h":
            return <div key={k} role="heading" aria-level={b.level} style={{ color: T.text, fontWeight: 700, fontSize: hSize[b.level], lineHeight: 1.3, margin: `${mt ?? 16}px 0 8px` }}>{inline(b.text, k)}</div>;
          case "hr":
            return <div key={k} style={{ height: 1, background: T.border, margin: "14px 0" }} />;
          case "ul":
            return <ul key={k} style={{ margin: `${mt ?? 8}px 0 8px`, paddingLeft: 20 }}>{b.items.map((it, j) => <li key={j} style={{ marginBottom: 4 }}>{inline(it, `${k}.${j}`)}</li>)}</ul>;
          case "ol":
            return <ol key={k} start={b.start} style={{ margin: `${mt ?? 8}px 0 8px`, paddingLeft: 22 }}>{b.items.map((it, j) => <li key={j} style={{ marginBottom: 4 }}>{inline(it, `${k}.${j}`)}</li>)}</ol>;
          case "quote":
            return <div key={k} style={{ borderLeft: `3px solid ${T.orange}`, padding: "2px 0 2px 12px", margin: `${mt ?? 8}px 0 8px`, color: T.text }}>{withBreaks(b.lines, k)}</div>;
          default:
            return <p key={k} style={{ margin: `${mt ?? 8}px 0 8px` }}>{withBreaks(b.lines, k)}</p>;
        }
      })}
    </div>
  );
}

export default RichText;
