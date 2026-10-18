import React from "react";
import { T } from "./ui";
import { openPayUrl } from "../utils/api";

// безопасный рендер: markdown+html → react (без сырого html)
const SAFE_URL = /^(https?:\/\/|mailto:|tg:\/\/)[^\s"'<>]+$/i;

export type RichTone = "doc" | "chat" | "chatOnAccent";

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

// блочные html-теги → строки в духе markdown для общего парсера
function htmlBlocksToLines(src: string): string {
  let s = src.replace(/\r\n?/g, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<hr\s*\/?>/gi, "\n---\n");
  // отбросить атрибуты, кроме href у ссылок
  s = s.replace(/<(p|h[1-3]|ul|ol|li|blockquote|b|strong|i|em|u|s|del|strike|code|br|hr)\s+[^<>]*?(\/?)>/gi, "<$1$2>");
  s = s.replace(/<h([1-3])\s*>([\s\S]*?)<\/h\1\s*>/gi, (_m, n: string, t: string) => `\n${"#".repeat(Number(n))} ${t.replace(/\n+/g, " ").trim()}\n`);
  s = s.replace(/<blockquote\s*>([\s\S]*?)<\/blockquote\s*>/gi, (_m, t: string) =>
    "\n" + t.trim().split("\n").map((l) => "> " + l).join("\n") + "\n");
  // нумерованный список html → «1. …»
  s = s.replace(/<ol\s*>([\s\S]*?)<\/ol\s*>/gi, (_m, inner: string) => {
    let i = 0;
    return "\n" + inner.replace(/<li\s*>([\s\S]*?)<\/li\s*>/gi, (_x, t: string) => `\n${++i}. ${t.replace(/\n+/g, " ").trim()}`) + "\n";
  });
  s = s.replace(/<li\s*>([\s\S]*?)<\/li\s*>/gi, (_m, t: string) => `\n- ${t.replace(/\n+/g, " ").trim()}`);
  s = s.replace(/<\/?(ul|ol)\s*>/gi, "\n");
  s = s.replace(/<p\s*>([\s\S]*?)<\/p\s*>/gi, (_m, t: string) => `\n${t.trim()}\n\n`);
  return s;
}

// lead: группа 1 = символ перед маркером (без lookbehind на старых ios)
type Rule = { re: RegExp; make: (m: RegExpExecArray, key: string) => React.ReactNode; lead?: boolean };

type ToneColors = {
  text: string; muted: string; link: string; codeBg: string; codeFg: string; border: string; quote: string; strong: string;
};

function colorsFor(tone: RichTone): ToneColors {
  if (tone === "chatOnAccent") {
    return {
      text: "inherit", muted: "inherit", link: "rgba(255,255,255,0.95)",
      codeBg: "rgba(0,0,0,0.18)", codeFg: "inherit", border: "rgba(255,255,255,0.35)", quote: "rgba(255,255,255,0.85)", strong: "inherit",
    };
  }
  if (tone === "chat") {
    return {
      text: "inherit", muted: "inherit", link: T.orangeBright,
      codeBg: T.surfaceRaised, codeFg: "inherit", border: T.border, quote: T.orange, strong: "inherit",
    };
  }
  return {
    text: T.text, muted: T.textMuted, link: T.orangeBright,
    codeBg: T.surfaceRaised, codeFg: T.text, border: T.border, quote: T.orange, strong: T.text,
  };
}

function Link({ href, children, color }: { href: string; children: React.ReactNode; color: string }) {
  const url = decodeEntities(href.trim());
  if (!SAFE_URL.test(url)) return <>{children}</>;
  return (
    <a href={url} style={{ color, textDecoration: "underline", cursor: "pointer" }} rel="noopener noreferrer" target="_blank"
      onClick={(e) => { if (/^https?:/i.test(url)) { e.preventDefault(); openPayUrl(url); } }}>
      {children}
    </a>
  );
}

function makeRules(c: ToneColors): Rule[] {
  const codeStyle: React.CSSProperties = {
    fontFamily: "ui-monospace, Menlo, monospace", fontSize: "0.92em", background: c.codeBg,
    borderRadius: 6, padding: "1px 5px", color: c.codeFg,
  };
  return [
    { re: /<(b|strong)\s*>([\s\S]+?)<\/\1\s*>/i, make: (m, k) => <strong key={k} style={{ color: c.strong, fontWeight: 600 }}>{inline(m[2], k, c)}</strong> },
    { re: /<(i|em)\s*>([\s\S]+?)<\/\1\s*>/i, make: (m, k) => <em key={k}>{inline(m[2], k, c)}</em> },
    { re: /<u\s*>([\s\S]+?)<\/u\s*>/i, make: (m, k) => <u key={k}>{inline(m[1], k, c)}</u> },
    { re: /<(s|del|strike)\s*>([\s\S]+?)<\/\1\s*>/i, make: (m, k) => <s key={k}>{inline(m[2], k, c)}</s> },
    { re: /<code\s*>([\s\S]+?)<\/code\s*>/i, make: (m, k) => <code key={k} style={codeStyle}>{decodeEntities(m[1])}</code> },
    { re: /<a\s+href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]+?)<\/a\s*>/i, make: (m, k) => <Link key={k} href={m[1] ?? m[2] ?? ""} color={c.link}>{inline(m[3], k, c)}</Link> },
    { re: /`([^`\n]+)`/, make: (m, k) => <code key={k} style={codeStyle}>{m[1]}</code> },
    { re: /\[([^\]\n]+)\]\(([^)\s]+)\)/, make: (m, k) => <Link key={k} href={m[2]} color={c.link}>{inline(m[1], k, c)}</Link> },
    { re: /\*\*([^*\n]+?)\*\*/, make: (m, k) => <strong key={k} style={{ color: c.strong, fontWeight: 600 }}>{inline(m[1], k, c)}</strong> },
    { re: /__([^_\n]+?)__/, make: (m, k) => <u key={k}>{inline(m[1], k, c)}</u> },
    { re: /~~([^~\n]+?)~~/, make: (m, k) => <s key={k}>{inline(m[1], k, c)}</s> },
    { re: /(^|[^\p{L}\p{N}*])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![\p{L}\p{N}*])/u, lead: true, make: (m, k) => <strong key={k} style={{ color: c.strong, fontWeight: 600 }}>{inline(m[2], k, c)}</strong> },
    { re: /(^|[^\p{L}\p{N}_])_([^_\s](?:[^_\n]*[^_\s])?)_(?![\p{L}\p{N}_])/u, lead: true, make: (m, k) => <em key={k}>{inline(m[2], k, c)}</em> },
  ];
}

function inline(text: string, keyBase = "i", c: ToneColors = colorsFor("doc")): React.ReactNode[] {
  const RULES = makeRules(c);
  const out: React.ReactNode[] = [];
  const res = RULES.map((r) => new RegExp(r.re.source, r.re.flags.includes("g") ? r.re.flags : r.re.flags + "g"));
  const cache: ({ m: RegExpExecArray; at: number } | null | undefined)[] = RULES.map(() => undefined);
  let pos = 0;
  let n = 0;
  while (pos < text.length) {
    let best = -1;
    let bestAt = Infinity;
    for (let i = 0; i < RULES.length; i++) {
      let hit = cache[i];
      if (hit === undefined || (hit !== null && hit.at < pos)) {
        res[i].lastIndex = RULES[i].lead ? Math.max(0, pos - 1) : pos;
        const m = res[i].exec(text);
        hit = m ? { m, at: m.index + (RULES[i].lead ? m[1].length : 0) } : null;
        if (hit && hit.at < pos) hit = null;
        cache[i] = hit;
      }
      if (hit && hit.at < bestAt) { bestAt = hit.at; best = i; }
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

function withBreaks(lines: string[], key: string, c: ToneColors): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  lines.forEach((l, i) => {
    if (i) out.push(<br key={`${key}.br${i}`} />);
    out.push(...inline(l, `${key}.${i}`, c));
  });
  return out;
}

export function RichText({ text, style, tone = "doc", compact }: {
  text: string; style?: React.CSSProperties; tone?: RichTone; compact?: boolean;
}) {
  const c = colorsFor(tone);
  const blocks = parseBlocks(text || "");
  const hSize = compact ? [0, 17, 15, 14] : [0, 19, 17, 15];
  const gap = compact ? 4 : 8;
  const hGap = compact ? 8 : 16;
  return (
    <div style={{ fontSize: compact ? "inherit" : 14, lineHeight: compact ? "inherit" : "21px", color: c.muted, wordBreak: "break-word", ...style }}>
      {blocks.map((b, i) => {
        const k = `b${i}`;
        const mt = i === 0 ? 0 : undefined;
        switch (b.t) {
          case "h":
            return <div key={k} role="heading" aria-level={b.level} style={{ color: c.text, fontWeight: 700, fontSize: hSize[b.level], lineHeight: 1.3, margin: `${mt ?? hGap}px 0 ${gap}px` }}>{inline(b.text, k, c)}</div>;
          case "hr":
            return <div key={k} style={{ height: 1, background: c.border, margin: `${compact ? 8 : 14}px 0` }} />;
          case "ul":
            return <ul key={k} style={{ margin: `${mt ?? gap}px 0 ${gap}px`, paddingLeft: 20 }}>{b.items.map((it, j) => <li key={j} style={{ marginBottom: 2 }}>{inline(it, `${k}.${j}`, c)}</li>)}</ul>;
          case "ol":
            return <ol key={k} start={b.start} style={{ margin: `${mt ?? gap}px 0 ${gap}px`, paddingLeft: 22 }}>{b.items.map((it, j) => <li key={j} style={{ marginBottom: 2 }}>{inline(it, `${k}.${j}`, c)}</li>)}</ol>;
          case "quote":
            return <div key={k} style={{ borderLeft: `3px solid ${c.quote}`, padding: "2px 0 2px 10px", margin: `${mt ?? gap}px 0 ${gap}px`, color: c.text }}>{withBreaks(b.lines, k, c)}</div>;
          default:
            return <p key={k} style={{ margin: `${mt ?? gap}px 0 ${gap}px` }}>{withBreaks(b.lines, k, c)}</p>;
        }
      })}
    </div>
  );
}

export default RichText;
